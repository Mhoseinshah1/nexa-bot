import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { TicketDetailPage, TicketsPage, dayEnd, dayStart } from '../../apps/web/src/pages/tickets';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * WP-A7 — the Web Admin's ticket inbox and conversation. Fixtures go through the real API
 * client and are parsed by the contract's schemas, so a fixture that drifts from the server
 * fails here.
 *
 * What this file defends: the inbox sends every filter the operator chose (status, category,
 * customer, assignee and a half-open date range) and links each row to its conversation; the
 * conversation shows who wrote what, each reply's delivery state and the attachment control;
 * a reply is sent with its idempotency key and no reason; only the status changes the machine
 * allows from where the ticket stands are offered; and every write is drawn only for the key
 * the server charges.
 */

const TICKET_ID = '019300ab-cdef-7012-8345-6789abcdef01';
const CATEGORY_ID = '019310ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019320ab-cdef-7012-8345-6789abcdef01';
const ADMIN_ID = '019330ab-cdef-7012-8345-6789abcdef01';

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: TICKET_ID,
  number: 42,
  status: 'WAITING_FOR_SUPPORT',
  priority: 'HIGH',
  categoryId: CATEGORY_ID,
  categoryTitle: 'مشکل اتصال',
  subject: 'سرویس وصل نمی‌شود',
  customerId: CUSTOMER_ID,
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

const message = (overrides: Record<string, unknown> = {}) => ({
  id: '019340ab-cdef-7012-8345-6789abcdef01',
  senderType: 'CUSTOMER',
  authorAdminId: null,
  authorAdminUsername: null,
  body: 'سلام، سرویس وصل نمی‌شود.',
  systemEvent: null,
  attachment: null,
  delivery: null,
  createdAt: '2026-09-20T10:00:00.000Z',
  ...overrides,
});

const detail = (ticket: Record<string, unknown> = {}, messages?: unknown[]) => ({
  ticket: summary(ticket),
  messages: messages ?? [
    message(),
    message({
      id: '019340ab-cdef-7012-8345-6789abcdef02',
      senderType: 'ADMIN',
      authorAdminId: ADMIN_ID,
      authorAdminUsername: 'owner',
      body: 'لطفاً برنامه را به‌روزرسانی کنید.',
      delivery: 'DELIVERED',
      createdAt: '2026-09-20T10:30:00.000Z',
    }),
    message({
      id: '019340ab-cdef-7012-8345-6789abcdef03',
      body: 'رسید را فرستادم.',
      attachment: {
        kind: 'DOCUMENT',
        mimeType: 'application/pdf',
        fileName: 'r.pdf',
        fileSize: 2048,
      },
      createdAt: '2026-09-20T10:40:00.000Z',
    }),
    message({
      id: '019340ab-cdef-7012-8345-6789abcdef04',
      senderType: 'ADMIN',
      authorAdminId: ADMIN_ID,
      authorAdminUsername: 'owner',
      body: 'پاسخ دوم',
      delivery: 'FAILED',
      createdAt: '2026-09-20T10:50:00.000Z',
    }),
  ],
  customer: {
    id: CUSTOMER_ID,
    telegramUserId: '951001',
    username: 'mary',
    displayName: 'مریم',
    status: 'ACTIVE',
  },
});

const categories = {
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

const route = (query = '') => ({ path: '/tickets', query: new URLSearchParams(query) });

describe('the ticket inbox', () => {
  it('lists tickets with Persian labels, linking each to its conversation', async () => {
    stubApi([
      { url: '/tickets', body: { tickets: [summary()], nextCursor: null } },
      { url: '/ticket-categories', body: categories },
    ]);
    renderPage(
      <TicketsPage route={route()} denied={false} mayAssign={false} mayEditCategories={false} />,
    );
    const link = await screen.findByRole('link', { name: '#42' });
    expect(link.getAttribute('href')).toBe(`/tickets/${TICKET_ID}`);
    const row = link.closest('tr') as HTMLElement;
    expect(within(row).getByText(t('web.ticket_status_waiting_for_support'))).toBeTruthy();
    expect(within(row).getByText(t('web.ticket_priority_high'))).toBeTruthy();
    expect(within(row).getByText(t('web.ticket_unassigned'))).toBeTruthy();
    expect(within(row).getByText('سرویس وصل نمی‌شود')).toBeTruthy();
    // No internal enum is shown to the operator.
    expect(screen.queryByText('WAITING_FOR_SUPPORT')).toBeNull();
  });

  it('sends every filter it holds, the date range as a half-open interval', async () => {
    const api = stubApi([
      { url: '/tickets', body: { tickets: [], nextCursor: null } },
      { url: '/ticket-categories', body: categories },
      { url: '/tickets/assignees', body: { admins: [] } },
    ]);
    renderPage(
      <TicketsPage
        route={route(
          `status=WAITING_FOR_SUPPORT&categoryId=${CATEGORY_ID}&customer=951001&assigned=me&from=2026-09-01&to=2026-09-10`,
        )}
        denied={false}
        mayAssign
        mayEditCategories={false}
      />,
    );
    await screen.findByText(t('web.tickets_filter_empty'));
    const list = api.calls.find((call) => call.url.includes('/tickets?'));
    expect(list).toBeDefined();
    const params = new URL(list!.url, 'http://x').searchParams;
    expect(params.get('status')).toBe('WAITING_FOR_SUPPORT');
    expect(params.get('categoryId')).toBe(CATEGORY_ID);
    expect(params.get('customer')).toBe('951001');
    expect(params.get('assigned')).toBe('me');
    expect(params.get('from')).toBe(dayStart('2026-09-01'));
    // The END date is included whole: the bound is the midnight after it.
    expect(params.get('to')).toBe(dayEnd('2026-09-10'));
    expect(
      new Date(params.get('to')!).getTime() - new Date(dayStart('2026-09-10')!).getTime(),
    ).toBe(24 * 60 * 60 * 1000);
  });

  it('draws the category editor only for the key that edits categories', async () => {
    stubApi([
      { url: '/tickets', body: { tickets: [], nextCursor: null } },
      { url: '/ticket-categories', body: categories },
    ]);
    const { unmount } = renderPage(
      <TicketsPage route={route()} denied={false} mayAssign={false} mayEditCategories={false} />,
    );
    await screen.findAllByText('مشکل اتصال');
    expect(screen.queryByRole('button', { name: t('web.ticket_category_add') })).toBeNull();
    unmount();

    const api = stubApi([
      { url: '/tickets', body: { tickets: [], nextCursor: null } },
      { url: '/ticket-categories', body: categories },
    ]);
    renderPage(<TicketsPage route={route()} denied={false} mayAssign={false} mayEditCategories />);
    fireEvent.change(
      await screen.findByLabelText(t('web.ticket_category_title'), {
        selector: '#ticket-category-title',
      }),
      {
        target: { value: '  نمایندگی ' },
      },
    );
    fireEvent.change(
      screen.getByLabelText(t('web.ticket_category_order'), { selector: '#ticket-category-order' }),
      {
        target: { value: '۶۰' },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: t('web.ticket_category_add') }));
    await waitFor(() =>
      expect(
        api.calls.some((call) => call.method === 'POST' && call.url.endsWith('/ticket-categories')),
      ).toBe(true),
    );
    const posted = api.calls.find((call) => call.method === 'POST')!;
    expect(posted.body).toMatchObject({ title: 'نمایندگی', sortOrder: 60 });
    expect(typeof (posted.body as { idempotencyKey: string }).idempotencyKey).toBe('string');
  });

  it('edits an existing category’s display order through the category update', async () => {
    const api = stubApi([
      { url: '/tickets', body: { tickets: [], nextCursor: null } },
      { url: '/ticket-categories', body: categories },
      {
        url: `/ticket-categories/${CATEGORY_ID}`,
        body: { category: { ...categories.categories[0], sortOrder: 25 }, changed: true },
      },
    ]);
    renderPage(<TicketsPage route={route()} denied={false} mayAssign={false} mayEditCategories />);
    const table = await screen.findByRole('table', { name: t('web.ticket_categories_title') });
    const order = within(table).getByLabelText(t('web.ticket_category_order'));
    const save = within(table).getByRole('button', { name: t('web.ticket_category_reorder') });
    expect((order as HTMLInputElement).value).toBe('10');
    // Unchanged, and then not a number: nothing to save either time.
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(order, { target: { value: '2.5' } });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    // Persian digits are read as the create form reads them.
    fireEvent.change(order, { target: { value: '۲۵' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) =>
            call.method === 'POST' && call.url.endsWith(`/ticket-categories/${CATEGORY_ID}`),
        ),
      ).toBe(true),
    );
    const posted = api.calls.find((call) =>
      call.url.endsWith(`/ticket-categories/${CATEGORY_ID}`),
    )!;
    expect(posted.body).toEqual({ sortOrder: 25 });
  });

  it('shows the display order as plain text to a viewer who cannot edit categories', async () => {
    stubApi([
      { url: '/tickets', body: { tickets: [], nextCursor: null } },
      { url: '/ticket-categories', body: categories },
    ]);
    renderPage(
      <TicketsPage route={route()} denied={false} mayAssign={false} mayEditCategories={false} />,
    );
    const table = await screen.findByRole('table', { name: t('web.ticket_categories_title') });
    expect(within(table).queryByLabelText(t('web.ticket_category_order'))).toBeNull();
    expect(
      within(table).queryByRole('button', { name: t('web.ticket_category_reorder') }),
    ).toBeNull();
    expect(within(table).getByText('10')).toBeTruthy();
  });

  it('is a navigation entry for tickets.view, and routes a conversation', () => {
    const entry = NAV.find((candidate) => candidate.id === 'tickets')!;
    expect(navPermitted(entry, ['tickets.view'])).toBe(true);
    expect(navPermitted(entry, ['orders.view'])).toBe(false);
    const resolved = resolve({ path: `/tickets/${TICKET_ID}`, query: new URLSearchParams() }, [
      'tickets.view',
    ]);
    expect(resolved.title).toBe(t('web.ticket_detail'));
  });
});

describe('one ticket', () => {
  it('shows who wrote what, each reply’s delivery, and the attachment control', async () => {
    stubApi([{ url: `/tickets/${TICKET_ID}`, body: detail() }]);
    renderPage(
      <TicketDetailPage
        id={TICKET_ID}
        denied={false}
        mayReply={false}
        mayAssign={false}
        mayClose={false}
      />,
    );
    expect(await screen.findByText('سلام، سرویس وصل نمی‌شود.')).toBeTruthy();
    expect(screen.getByText('لطفاً برنامه را به‌روزرسانی کنید.')).toBeTruthy();
    expect(screen.getByText(t('web.ticket_delivery_delivered'))).toBeTruthy();
    // A failed delivery is shown, and the reply is still there beside it.
    expect(screen.getByText(t('web.ticket_delivery_failed'))).toBeTruthy();
    expect(screen.getByText('پاسخ دوم')).toBeTruthy();
    expect(screen.getByRole('button', { name: t('web.ticket_attachment_download') })).toBeTruthy();
    // Without the keys, no reply form and no status buttons.
    expect(screen.queryByLabelText(t('web.ticket_reply_text'))).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.ticket_action_close') })).toBeNull();
  });

  it('sends a reply with its idempotency key, and asks for no reason', async () => {
    const api = stubApi([
      { url: `/tickets/${TICKET_ID}`, body: detail() },
      {
        url: `/tickets/${TICKET_ID}/messages`,
        body: {
          ticket: summary({ status: 'WAITING_FOR_CUSTOMER' }),
          message: message({
            id: '019340ab-cdef-7012-8345-6789abcdef09',
            senderType: 'ADMIN',
            authorAdminId: ADMIN_ID,
            authorAdminUsername: 'owner',
            body: 'درست شد؟',
            delivery: 'PENDING',
          }),
        },
      },
    ]);
    renderPage(
      <TicketDetailPage
        id={TICKET_ID}
        denied={false}
        mayReply
        mayAssign={false}
        mayClose={false}
      />,
    );
    const box = await screen.findByLabelText(t('web.ticket_reply_text'));
    const send = screen.getByRole('button', { name: t('web.ticket_reply_send') });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: '  درست شد؟ ' } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith(`/tickets/${TICKET_ID}/messages`))).toBe(
        true,
      ),
    );
    const posted = api.calls.find((call) => call.url.endsWith('/messages'))!;
    expect(posted.method).toBe('POST');
    expect(Object.keys(posted.body as object).sort()).toEqual(['idempotencyKey', 'text']);
    expect((posted.body as { text: string }).text).toBe('درست شد؟');
  });

  it('offers only the status changes the machine allows from where the ticket stands', async () => {
    const api = stubApi([
      { url: `/tickets/${TICKET_ID}`, body: detail({ status: 'OPEN' }) },
      {
        url: `/tickets/${TICKET_ID}/status`,
        body: {
          ticket: summary({ status: 'CLOSED', closedAt: '2026-09-20T12:00:00.000Z' }),
          changed: true,
        },
      },
    ]);
    renderPage(
      <TicketDetailPage
        id={TICKET_ID}
        denied={false}
        mayReply={false}
        mayAssign={false}
        mayClose
      />,
    );
    const close = await screen.findByRole('button', { name: t('web.ticket_action_close') });
    expect(screen.getByRole('button', { name: t('web.ticket_action_wait_customer') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('web.ticket_action_wait_support') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('web.ticket_action_reopen') })).toBeNull();
    fireEvent.click(close);
    await waitFor(() =>
      expect(api.calls.find((call) => call.url.endsWith('/status'))?.body).toEqual({
        status: 'CLOSED',
      }),
    );
  });

  it('offers a closed ticket one way back, and no reply form until it is reopened', async () => {
    stubApi([
      {
        url: `/tickets/${TICKET_ID}`,
        body: detail({ status: 'CLOSED', closedAt: '2026-09-20T12:00:00.000Z' }),
      },
    ]);
    renderPage(
      <TicketDetailPage id={TICKET_ID} denied={false} mayReply mayAssign={false} mayClose />,
    );
    expect(await screen.findByRole('button', { name: t('web.ticket_action_reopen') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('web.ticket_action_close') })).toBeNull();
    expect(screen.getByText(t('web.ticket_reply_closed'))).toBeTruthy();
    expect(screen.queryByLabelText(t('web.ticket_reply_text'))).toBeNull();
  });

  it('shows the customer and the linked context, and assigns from the list the server gives', async () => {
    const api = stubApi([
      {
        url: `/tickets/${TICKET_ID}`,
        body: detail({ orderId: '019350ab-cdef-7012-8345-6789abcdef01' }),
      },
      {
        url: '/tickets/assignees',
        body: { admins: [{ id: ADMIN_ID, username: 'support1', displayName: 'پشتیبان' }] },
      },
      {
        url: `/tickets/${TICKET_ID}/assignee`,
        body: {
          ticket: summary({ assignedAdminId: ADMIN_ID, assignedAdminUsername: 'support1' }),
          changed: true,
        },
      },
    ]);
    renderPage(
      <TicketDetailPage
        id={TICKET_ID}
        denied={false}
        mayReply={false}
        mayAssign
        mayClose={false}
      />,
    );
    const order = await screen.findByRole('link', { name: '019350ab' });
    expect(order.getAttribute('href')).toBe('/orders/019350ab-cdef-7012-8345-6789abcdef01');
    expect(screen.getByRole('link', { name: 'مریم' }).getAttribute('href')).toBe(
      `/users/${CUSTOMER_ID}`,
    );
    const select = await screen.findByLabelText(t('web.ticket_assignee'), { selector: 'select' });
    await screen.findByRole('option', { name: 'پشتیبان (@support1)' });
    fireEvent.change(select, { target: { value: ADMIN_ID } });
    await waitFor(() =>
      expect(api.calls.find((call) => call.url.endsWith('/assignee'))?.body).toEqual({
        adminId: ADMIN_ID,
      }),
    );
  });
});
