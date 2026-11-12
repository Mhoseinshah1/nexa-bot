import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PaymentDetailPage, PaymentsPage } from '../../apps/web/src/pages/payments';
import { PaymentGatewaysPage } from '../../apps/web/src/pages/payment-gateways';
import { TicketDetailPage, TicketsPage } from '../../apps/web/src/pages/tickets';
import { BusinessChatDetailPage, BusinessChatsPage } from '../../apps/web/src/pages/business-chats';
import { LearningCandidatesPage } from '../../apps/web/src/pages/support-knowledge';
import { NotificationCenterPage } from '../../apps/web/src/pages/notification-center';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';
import { openFilterPanel } from './ui-helpers';

/**
 * Demo parity, PR-2 (payments, gateways, tickets, business chats, support, notification
 * center): every element the owner's diff report listed as «only in the demo» is asserted here
 * and every «only in the app» one is asserted absent. Removing a restored element — a column, a
 * box, the inline categories table, the title badge, the CSV row, the «بیشتر» menu — fails a
 * case below (the PR's mutation checks name which).
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ROW_ID = '019240ab-cdef-7012-8345-6789abcdef01';
const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';

const payment = (overrides: Record<string, unknown> = {}) => ({
  id: ROW_ID,
  customerId: CUSTOMER_ID,
  orderId: ORDER_ID,
  state: 'UNKNOWN',
  method: 'GATEWAY',
  amount: '250000',
  currency: 'IRT',
  reference: 'a1b2c3d4e5f60718:gw',
  evidenceKind: null,
  confirmedAt: null,
  confirmedByAdminId: null,
  resolvedAt: null,
  resolvedByAdminId: null,
  customerSignalledAt: null,
  expiresAt: null,
  createdAt: '2026-09-10T12:30:00.000Z',
  updatedAt: '2026-09-10T12:30:00.000Z',
  gatewayProvider: 'TONPAYS',
  receiptDisposition: 'APPROVED',
  situation: {
    situation: 'OUTCOME_UNKNOWN',
    money: 'POSSIBLY',
    customer: 'WAIT_DO_NOT_PAY_AGAIN',
    actions: ['ASK_PROVIDER_AGAIN', 'RECONCILE'],
    needsAction: true,
  },
  ...overrides,
});

const paymentRoutes = (rows: unknown[]) => [
  { url: '/payments', body: { payments: rows, nextCursor: null } },
  {
    url: '/payment-operations/attention',
    body: {
      window: null,
      byGateway: [],
      totals: {},
      generatedAt: '2026-10-07T09:00:00.000Z',
    },
  },
];

const headersOf = (table: HTMLElement) =>
  within(table)
    .getAllByRole('columnheader')
    .map((cell) => cell.textContent);

describe('/payments (demo parity)', () => {
  it('draws «وضعیت عملیاتی», «نتیجهٔ رسید» and «درگاه» as columns of their own, with their cells', async () => {
    stubApi(paymentRoutes([payment()]));
    renderPage(
      <PaymentsPage route={{ path: '/payments', query: new URLSearchParams() }} denied={false} />,
    );
    await screen.findByText('a1b2c3d4e5f60718');
    const table = screen.getByRole('table');
    const headers = headersOf(table);
    for (const key of [
      'web.payment_ops_situation',
      'web.payment_disposition',
      'web.payment_gateway',
    ] as const) {
      expect(headers, key).toContain(t(key));
    }
    const cellOf = (key: 'web.payment_ops_situation' | 'web.payment_disposition') =>
      within(table).getAllByRole('row')[1]!.querySelectorAll('td')[headers.indexOf(t(key))]!;
    expect(cellOf('web.payment_ops_situation').textContent).toContain(
      t('web.payment_situation_outcome_unknown'),
    );
    expect(cellOf('web.payment_disposition').textContent).toContain(
      t('web.payment_disposition_approved'),
    );
  });

  it('has no queue chip row: every queue and filter is inside the «فیلترها» panel', async () => {
    stubApi(paymentRoutes([payment()]));
    renderPage(
      <PaymentsPage route={{ path: '/payments', query: new URLSearchParams() }} denied={false} />,
    );
    await screen.findByText('a1b2c3d4e5f60718');
    expect(screen.queryByRole('group', { name: t('web.payment_ops_queue') })).toBeNull();
    const panel = openFilterPanel();
    for (const key of [
      'web.payment_ops_queue',
      'web.payment_gateway',
      'web.payment_ops_range',
      'web.payment_state',
      'web.payment_method',
      'web.payment_disposition',
    ] as const) {
      expect(within(panel).getByRole('group', { name: t(key) }), key).toBeTruthy();
    }
  });

  it('draws «خروجی CSV» always, and exports the loaded rows with a BOM and a Persian header row', async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return 'blob:x';
    });
    URL.revokeObjectURL = vi.fn();
    stubApi(paymentRoutes([payment()]));
    renderPage(
      <PaymentsPage route={{ path: '/payments', query: new URLSearchParams() }} denied={false} />,
    );
    await screen.findByText('a1b2c3d4e5f60718');
    const bar = screen.getByRole('group', { name: t('web.export_bar') });
    fireEvent.click(within(bar).getByRole('button', { name: t('web.export_csv') }));
    expect(created).toHaveLength(1);
    const bytes = await new Promise<Uint8Array>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(created[0]!);
    });
    // UTF-8 BOM (EF BB BF) so Excel reads the Persian.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes.slice(3)).trim().split('\r\n');
    expect(lines[0]).toContain(t('web.payment_ops_situation'));
    expect(lines[0]).toContain(t('web.payment_gateway'));
    expect(lines[0]).toContain(t('web.payment_disposition'));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('a1b2c3d4e5f60718');
  });

  it('draws the page head «بیشتر» menu with the filters reset and the methods page', async () => {
    stubApi(paymentRoutes([payment()]));
    renderPage(
      <PaymentsPage route={{ path: '/payments', query: new URLSearchParams() }} denied={false} />,
    );
    await screen.findByText('a1b2c3d4e5f60718');
    fireEvent.click(screen.getByRole('button', { name: t('web.page_more_menu') }));
    expect(screen.getByRole('menuitem', { name: t('web.filters_clear_all') })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: t('web.payment_gateways_title') })).toBeTruthy();
  });
});

describe('/payments/:id (demo parity)', () => {
  const detail = (overrides: Record<string, unknown> = {}) => [
    {
      url: `/payments/${ROW_ID}`,
      body: {
        payment: {
          ...payment({ state: 'CONFIRMED', method: 'MANUAL_TRANSFER', ...overrides }),
          evidenceNote: null,
          resolutionNote: null,
          destination: null,
        },
      },
    },
  ];

  it('makes the status badge part of the h1 title, and draws no quick-action strip or state chip', async () => {
    stubApi(detail());
    const view = renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayViewReceipts
        mayViewRefunds
        mayIssueRefunds
        denied={false}
      />,
    );
    const title = await screen.findByRole('heading', { level: 1 });
    await waitFor(() => expect(title.textContent).toContain(t('web.payment_state_confirmed')));
    // The two buttons the demo does not have: the jump strip.
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.pay_attn_review') })).toBeNull();
    // The header card no longer repeats the state as a chip.
    const head = view.container.querySelector('.pay-head') as HTMLElement;
    expect(within(head).queryByText(t('web.payment_state_confirmed'))).toBeNull();
  });
});

describe('/payment-gateways (demo parity)', () => {
  const ROW = {
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
    allowWalletTopup: true,
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T12:30:00.000Z',
  };

  it('draws an «عملیات» column with a «مدیریت» link per row, to the route’s own page', async () => {
    stubApi([
      {
        url: '/payment-gateways',
        body: { gateways: [ROW, { ...ROW, provider: 'NOWPAYMENTS' }] },
      },
    ]);
    renderPage(<PaymentGatewaysPage denied={false} mayEdit />);
    const table = await screen.findByRole('table');
    expect(headersOf(table)).toContain(t('web.payment_gateway_col_actions'));
    const manage = within(table).getAllByRole('link', { name: t('web.payment_method_open') });
    expect(manage.map((link) => link.getAttribute('href'))).toEqual([
      '/payment-gateways/card-to-card',
      '/payment-gateways/nowpayments',
    ]);
  });

  it('keeps a provider’s own view free of the «عملیات» column', async () => {
    stubApi([{ url: '/payment-gateways', body: { gateways: [ROW] } }]);
    renderPage(<PaymentGatewaysPage provider="MANUAL_TRANSFER" denied={false} mayEdit />);
    await screen.findByText(t('web.payment_method_settings'));
    expect(screen.queryByRole('link', { name: t('web.payment_method_open') })).toBeNull();
  });
});

const TICKET_ID = '019300ab-cdef-7012-8345-6789abcdef01';
const CATEGORY_ID = '019310ab-cdef-7012-8345-6789abcdef01';
const TICKET_CUSTOMER_ID = '019320ab-cdef-7012-8345-6789abcdef01';

const ticket = (overrides: Record<string, unknown> = {}) => ({
  id: TICKET_ID,
  number: 42,
  status: 'OPEN',
  priority: 'HIGH',
  categoryId: CATEGORY_ID,
  categoryTitle: 'مشکل اتصال',
  subject: 'سرویس وصل نمی‌شود',
  customerId: TICKET_CUSTOMER_ID,
  customerTelegramUserId: '951001',
  customerUsername: 'mary',
  customerDisplayName: 'مریم',
  assignedAdminId: null,
  assignedAdminUsername: null,
  serviceId: null,
  orderId: null,
  paymentId: null,
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T11:00:00.000Z',
  lastMessageAt: '2026-09-20T11:00:00.000Z',
  closedAt: null,
  ...overrides,
});

const CATEGORIES = {
  categories: [
    {
      id: CATEGORY_ID,
      title: 'مشکل اتصال',
      sortOrder: 10,
      isActive: true,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ],
};

describe('/tickets (demo parity)', () => {
  const open = (mayEditCategories: boolean) => {
    const api = stubApi([
      { url: '/tickets', body: { tickets: [ticket()], nextCursor: null } },
      { url: '/ticket-categories', body: CATEGORIES, method: 'GET' },
      {
        url: `/ticket-categories/${CATEGORY_ID}`,
        method: 'POST',
        body: { category: { ...CATEGORIES.categories[0], isActive: false }, changed: true },
      },
    ]);
    renderPage(
      <TicketsPage
        route={{ path: '/tickets', query: new URLSearchParams() }}
        denied={false}
        mayAssign={false}
        mayEditCategories={mayEditCategories}
      />,
    );
    return api;
  };

  it('splits «وضعیت», «اولویت», «آخرین پیام» and «زمان ثبت» into columns, with no merged header', async () => {
    open(false);
    await screen.findByRole('link', { name: '#42' });
    const headers = headersOf(screen.getAllByRole('table')[0]!);
    for (const key of [
      'web.status',
      'web.ticket_priority',
      'web.ticket_last_message',
      'web.ticket_created_at',
    ] as const) {
      expect(headers, key).toContain(t(key));
    }
    expect(headers).not.toContain(
      `${t('web.status')}${t('web.list_separator')}${t('web.ticket_priority')}`,
    );
  });

  it('has no status chip row: the status is a filter of the «فیلترها» panel', async () => {
    open(false);
    await screen.findByRole('link', { name: '#42' });
    expect(screen.queryByRole('group', { name: t('web.status') })).toBeNull();
    expect(within(openFilterPanel()).getByRole('group', { name: t('web.status') })).toBeTruthy();
  });

  it('draws the «دسته‌های تیکت» table inline — no button opens it — with its title and order columns', async () => {
    open(true);
    const table = await screen.findByRole('table', { name: t('web.ticket_categories_title') });
    expect(screen.queryByRole('button', { name: t('web.ticket_categories_title') })).toBeNull();
    const headers = headersOf(table);
    expect(headers).toContain(t('web.ticket_category_title'));
    expect(headers).toContain(t('web.ticket_category_order'));
    expect(screen.getByRole('button', { name: t('web.ticket_category_add') })).toBeTruthy();
    expect(
      within(table).getByRole('button', { name: t('web.ticket_category_rename') }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: t('web.ticket_category_reorder') })).toBeTruthy();
    expect(within(table).getByRole('button', { name: t('web.ticket_category_hide') })).toBeTruthy();
  });

  it('hides a category from the bot with the existing category update', async () => {
    const api = open(true);
    const table = await screen.findByRole('table', { name: t('web.ticket_categories_title') });
    fireEvent.click(within(table).getByRole('button', { name: t('web.ticket_category_hide') }));
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) =>
            call.method === 'POST' && call.url.endsWith(`/ticket-categories/${CATEGORY_ID}`),
        ),
      ).toBe(true),
    );
    expect(api.calls.find((call) => call.method === 'POST')!.body).toEqual({ isActive: false });
  });

  it('locks the order inputs while «ذخیرهٔ ترتیب» runs, so no edit is dropped when it succeeds', async () => {
    open(true);
    const table = await screen.findByRole('table', { name: t('web.ticket_categories_title') });
    const input = within(table).getByRole('textbox', {
      name: `${t('web.ticket_category_order')} — مشکل اتصال`,
    }) as HTMLInputElement;
    // The save never answers: the mutation stays pending.
    const answered = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown, init?: RequestInit) =>
        (init?.method ?? 'GET') === 'POST'
          ? new Promise<Response>(() => {})
          : (answered as typeof fetch)(input as RequestInfo, init),
      ),
    );
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.ticket_category_reorder') }));
    await waitFor(() => expect(input.disabled).toBe(true));
  });
});

describe('/tickets/:id (demo parity)', () => {
  it('draws «مدیریت تیکت» as a framed box with titled groups', async () => {
    stubApi([
      {
        url: `/tickets/${TICKET_ID}`,
        body: {
          ticket: { origin: 'BOT', ...ticket() },
          escalations: [],
          messages: [],
          customer: {
            id: TICKET_CUSTOMER_ID,
            telegramUserId: '951001',
            username: 'mary',
            displayName: 'مریم',
            status: 'ACTIVE',
          },
        },
      },
    ]);
    renderPage(
      <TicketDetailPage id={TICKET_ID} denied={false} mayReply={false} mayAssign mayClose />,
    );
    const box = await screen.findByRole('region', { name: t('web.ticket_actions') });
    expect(box.className).toContain('action-panel');
    expect(within(box).getAllByRole('group').length).toBeGreaterThanOrEqual(2);
    expect(within(box).getByRole('button', { name: t('web.ticket_action_close') })).toBeTruthy();
    expect(within(box).getByRole('button', { name: t('web.ticket_assignee_change') })).toBeTruthy();
    // A reader who may not close or assign sees no box at all.
    cleanup();
    stubApi([
      {
        url: `/tickets/${TICKET_ID}`,
        body: {
          ticket: { origin: 'BOT', ...ticket() },
          escalations: [],
          messages: [],
          customer: {
            id: TICKET_CUSTOMER_ID,
            telegramUserId: '951001',
            username: 'mary',
            displayName: 'مریم',
            status: 'ACTIVE',
          },
        },
      },
    ]);
    renderPage(
      <TicketDetailPage
        id={TICKET_ID}
        denied={false}
        mayReply={false}
        mayAssign={false}
        mayClose={false}
      />,
    );
    await screen.findByText(t('web.ticket_summary'));
    expect(screen.queryByRole('region', { name: t('web.ticket_actions') })).toBeNull();
  });
});

const CHAT_ID = '019400ab-cdef-7012-8345-6789abcdef01';
const CHAT_CUSTOMER_ID = '019410ab-cdef-7012-8345-6789abcdef01';

const chat = (overrides: Record<string, unknown> = {}) => ({
  id: CHAT_ID,
  state: 'HANDOFF_REQUIRED',
  takeoverReason: null,
  handoffReason: 'SEND_OUTCOME_UNKNOWN',
  peerTelegramUserId: '951001',
  customer: { id: CHAT_CUSTOMER_ID, username: 'mary', firstName: 'مریم' },
  connectionStatus: 'ACTIVE',
  lastMessageAt: '2026-10-01T10:00:00.000Z',
  lastInboundAt: '2026-10-01T10:00:00.000Z',
  preview: 'سرویس وصل نمی‌شود',
  unansweredSince: null,
  ticketId: null,
  ...overrides,
});

describe('/business-chats (demo parity)', () => {
  it('draws «آخرین پیام» and «زمان آخرین پیام» as two columns, and the state only in the panel', async () => {
    stubApi([
      { url: '/business-chats', body: { conversations: [chat()], nextCursor: null } },
      { url: '/business-connections', body: { connections: [] } },
    ]);
    renderPage(
      <BusinessChatsPage
        route={{ path: '/business-chats', query: new URLSearchParams() }}
        denied={false}
      />,
    );
    await screen.findByText('سرویس وصل نمی‌شود');
    const headers = headersOf(screen.getAllByRole('table')[0]!);
    expect(headers).toContain(t('web.bchat_last_preview'));
    expect(headers).toContain(t('web.bchat_last_message'));
    expect(t('web.bchat_last_preview')).toBe('آخرین پیام');
    expect(screen.queryByRole('group', { name: t('web.status') })).toBeNull();
    expect(within(openFilterPanel()).getByRole('group', { name: t('web.status') })).toBeTruthy();
  });

  it('titles a conversation «گفتگوی بیزینس، <name>» with the state as its badge', async () => {
    stubApi([
      {
        url: `/business-chats/${CHAT_ID}`,
        body: {
          conversation: { ...chat(), controlEpoch: 3, lastHumanAt: null },
          escalations: [],
          messages: [],
          outbound: [],
        },
      },
    ]);
    renderPage(<BusinessChatDetailPage id={CHAT_ID} denied={false} mayReply={false} />);
    const title = await screen.findByRole('heading', {
      level: 1,
      name: /گفتگوی بیزینس، مریم/u,
    });
    expect(title.textContent).toContain(t('web.bchat_state_handoff_required'));
  });
});

describe('/support-learning and /notification-center (demo parity)', () => {
  it('keeps the learning-candidate state in the «فیلترها» panel, not a chip row', async () => {
    stubApi([{ url: '/support-learning/candidates', body: { candidates: [] } }]);
    renderPage(<LearningCandidatesPage denied={false} mayReview />);
    await screen.findByText(t('web.sk_cand_title'), { selector: 'h1' });
    expect(screen.queryByRole('group', { name: t('web.sk_cand_state') })).toBeNull();
    expect(
      within(openFilterPanel()).getByRole('combobox', { name: t('web.sk_cand_state') }),
    ).toBeTruthy();
  });

  it('puts the alert feeds in the panel, the unread/all pair on the page and the re-read in the «بیشتر» menu', async () => {
    stubApi([
      {
        url: '/notification-center/summary',
        body: { unread: 2, atLeast: false, highestUnread: 'WARN' },
      },
      { url: '/notification-center', body: { notifications: [], nextCursor: null } },
    ]);
    renderPage(<NotificationCenterPage permissions={['payments.view']} />);
    await screen.findByText(t('web.nc_empty_unread'));
    // The real demo's «خوانده‌نشده | همه» pair is on the page itself, not only inside the panel.
    expect(screen.getByRole('button', { name: t('web.nc_filter_unread') })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: t('web.nc_filter_all') })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.queryByRole('group', { name: t('web.nc_filters_label') })).toBeNull();
    expect(
      within(openFilterPanel()).getByRole('group', { name: t('web.nc_filters_label') }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('web.page_more_menu') }));
    expect(screen.getByRole('menuitem', { name: t('web.nc_reread') })).toBeTruthy();
  });
});
