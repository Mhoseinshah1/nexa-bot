import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  TicketDetailPage,
  TicketsPage,
  dayEnd,
  dayStart,
  ticketFault,
} from '../../apps/web/src/pages/tickets';
import { ApiError } from '../../apps/web/src/api/client';
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
  attachmentDelivery: null,
  createdAt: '2026-09-20T10:00:00.000Z',
  ...overrides,
});

const detail = (ticket: Record<string, unknown> = {}, messages?: unknown[]) => ({
  ticket: { origin: 'BOT', ...summary(ticket) },
  escalations: [],
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

  // --- HF-A7: support's file on a reply -------------------------------------------------

  const replyPage = () => {
    const api = stubApi([
      { url: `/tickets/${TICKET_ID}`, body: detail() },
      {
        url: `/tickets/${TICKET_ID}/messages`,
        body: {
          ticket: summary({ status: 'WAITING_FOR_CUSTOMER' }),
          message: message({
            id: '019340ab-cdef-7012-8345-6789abcdef0a',
            senderType: 'ADMIN',
            authorAdminId: ADMIN_ID,
            authorAdminUsername: 'owner',
            body: 'تصویر پیوست است.',
            attachment: {
              kind: 'PHOTO',
              mimeType: 'image/png',
              fileName: 'screen.png',
              fileSize: 12,
            },
            delivery: 'PENDING',
            attachmentDelivery: 'PENDING',
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
    return api;
  };
  const pick = async (file: File) => {
    const input = await screen.findByLabelText(t('web.ticket_reply_file'));
    fireEvent.change(input, { target: { files: [file] } });
  };
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x41, 0x42, 0x43, 0x44,
  ]);
  const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

  it('sends support’s file with the reply, as base64 beside the text', async () => {
    const api = replyPage();
    fireEvent.change(await screen.findByLabelText(t('web.ticket_reply_text')), {
      target: { value: 'تصویر پیوست است.' },
    });
    await pick(new File([PNG], 'screen.png', { type: 'image/png' }));
    const send = screen.getByRole('button', { name: t('web.ticket_reply_send') });
    // Sendable only once the file has been read and judged.
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/messages'))).toBe(true),
    );
    const posted = api.calls.find((call) => call.url.endsWith('/messages'))!;
    expect(posted.body).toMatchObject({
      text: 'تصویر پیوست است.',
      attachment: {
        fileName: 'screen.png',
        mimeType: 'image/png',
        contentBase64: Buffer.from(PNG).toString('base64'),
      },
    });
  });

  it('refuses a spoofed, unlisted or oversized file in Persian before anything is sent', async () => {
    const api = replyPage();
    fireEvent.change(await screen.findByLabelText(t('web.ticket_reply_text')), {
      target: { value: 'پیوست' },
    });
    const send = screen.getByRole('button', { name: t('web.ticket_reply_send') });

    // A program renamed to a PDF: the bytes say what it is.
    await pick(new File([EXE], 'guide.pdf', { type: 'application/pdf' }));
    expect(await screen.findByText(t('web.ticket_reply_file_content'))).toBeTruthy();
    expect((send as HTMLButtonElement).disabled).toBe(true);

    // An executable declared as one.
    await pick(new File([EXE], 'setup.exe', { type: 'application/x-msdownload' }));
    expect(await screen.findByText(t('web.ticket_reply_file_type'))).toBeTruthy();

    // An executable's extension hidden inside the name.
    await pick(
      new File([new TextEncoder().encode('%PDF-1.7')], 'a.exe.pdf', { type: 'application/pdf' }),
    );
    expect(await screen.findByText(t('web.ticket_reply_file_name'))).toBeTruthy();

    // One byte over a photo's bound, refused without reading it.
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set(PNG);
    await pick(new File([big], 'big.png', { type: 'image/png' }));
    expect(await screen.findByText(t('web.ticket_reply_file_too_large'))).toBeTruthy();
    expect((send as HTMLButtonElement).disabled).toBe(true);

    // Removing the file sends the text alone.
    fireEvent.click(screen.getByRole('button', { name: t('web.ticket_reply_file_clear') }));
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/messages'))).toBe(true),
    );
    const posted = api.calls.find((call) => call.url.endsWith('/messages'))!;
    expect(Object.keys(posted.body as object).sort()).toEqual(['idempotencyKey', 'text']);
  });

  it('sends the file the input shows when an earlier read finishes last, and nothing while one is read (Codex #108)', async () => {
    // A FileReader whose reads finish when the test says so, in the order it says.
    const original = globalThis.FileReader;
    const pending: DeferredReader[] = [];
    class DeferredReader {
      result: ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private file: File | null = null;
      readAsArrayBuffer(file: File) {
        this.file = file;
        pending.push(this);
      }
      /** The real reader's answer, delivered now. */
      async finish() {
        const file = this.file as File;
        this.result = await new Promise<ArrayBuffer>((resolve) => {
          const real = new original();
          real.onload = () => resolve(real.result as ArrayBuffer);
          real.readAsArrayBuffer(file);
        });
        this.onload?.();
      }
    }
    vi.stubGlobal('FileReader', DeferredReader);
    try {
      const api = replyPage();
      fireEvent.change(await screen.findByLabelText(t('web.ticket_reply_text')), {
        target: { value: 'کدام فایل؟' },
      });
      const send = screen.getByRole('button', { name: t('web.ticket_reply_send') });
      const FIRST = new Uint8Array([...PNG, 0x01]);
      const SECOND = new Uint8Array([...PNG, 0x02]);
      await pick(new File([FIRST], 'first.png', { type: 'image/png' }));
      await pick(new File([SECOND], 'second.png', { type: 'image/png' }));
      expect(pending).toHaveLength(2);
      // The FIRST file's read finishes while the second is still being read: nothing is sent.
      await act(async () => {
        await (pending[0] as DeferredReader).finish();
      });
      expect(send).toBeDisabled();
      fireEvent.click(send);
      expect(api.calls.some((call) => call.url.endsWith('/messages'))).toBe(false);
      // The second finishes: it, and only it, is what goes.
      await act(async () => {
        await (pending[1] as DeferredReader).finish();
      });
      await waitFor(() => expect(send).toBeEnabled());
      fireEvent.click(send);
      await waitFor(() =>
        expect(api.calls.some((call) => call.url.endsWith('/messages'))).toBe(true),
      );
      const posted = api.calls.find((call) => call.url.endsWith('/messages'))!.body as {
        attachment: { fileName: string; contentBase64: string };
      };
      expect(posted.attachment.fileName).toBe('second.png');
      expect(posted.attachment.contentBase64).toBe(Buffer.from(SECOND).toString('base64'));
    } finally {
      vi.stubGlobal('FileReader', original);
    }
  });

  it('gives a different file a new key after an ambiguous failure, even with the same name and size (Codex #108)', async () => {
    const api = stubApi([
      { url: `/tickets/${TICKET_ID}`, body: detail() },
      {
        url: `/tickets/${TICKET_ID}/messages`,
        status: 503,
        body: {
          error: {
            kind: 'unavailable',
            code: 'platform.unavailable',
            message: 'try again',
            correlationId: 'test',
          },
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
    fireEvent.change(await screen.findByLabelText(t('web.ticket_reply_text')), {
      target: { value: 'پیوست' },
    });
    const posts = () => api.calls.filter((call) => call.url.endsWith('/messages'));
    const sendWith = async (bytes: Uint8Array<ArrayBuffer>, count: number) => {
      await pick(new File([bytes], 'screen.png', { type: 'image/png' }));
      const send = screen.getByRole('button', { name: t('web.ticket_reply_send') });
      await waitFor(() => expect(send).toBeEnabled());
      fireEvent.click(send);
      await waitFor(() => expect(posts()).toHaveLength(count));
      await waitFor(() => expect(send).toBeEnabled());
    };
    const keyOf = (index: number) =>
      (posts()[index]?.body as { idempotencyKey: string }).idempotencyKey;

    await sendWith(new Uint8Array([...PNG, 0x01]), 1);
    // The same file again is a retry of the same question: the held key.
    await sendWith(new Uint8Array([...PNG, 0x01]), 2);
    expect(keyOf(1)).toBe(keyOf(0));
    // A different file with the same name and the same size is a new command.
    await sendWith(new Uint8Array([...PNG, 0x02]), 3);
    expect(keyOf(2)).not.toBe(keyOf(0));
  });

  it('names the server’s own refusal of a file, and a full staging area, in Persian', () => {
    expect(
      ticketFault(
        new ApiError(422, 'ticket.attachment_refused', 'refused', { refusal: 'CONTENT_MISMATCH' }),
      ),
    ).toBe(t('web.ticket_reply_file_content'));
    expect(ticketFault(new ApiError(409, 'ticket.attachment_storage_full', 'full', {}))).toBe(
      t('web.ticket_fault_storage_full'),
    );
  });

  it('shows support’s file and its own delivery beside the text’s', async () => {
    stubApi([
      {
        url: `/tickets/${TICKET_ID}`,
        body: detail({}, [
          message({
            id: '019340ab-cdef-7012-8345-6789abcdef0b',
            senderType: 'ADMIN',
            authorAdminId: ADMIN_ID,
            authorAdminUsername: 'owner',
            body: 'راهنما پیوست است.',
            attachment: {
              kind: 'DOCUMENT',
              mimeType: 'application/pdf',
              fileName: 'guide.pdf',
              fileSize: 4096,
            },
            delivery: 'DELIVERED',
            attachmentDelivery: 'UNCONFIRMED',
          }),
        ]),
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
    expect(await screen.findByText('guide.pdf')).toBeTruthy();
    expect(screen.getByText(t('web.ticket_attachment_delivery'))).toBeTruthy();
    expect(screen.getByText(t('web.ticket_delivery_delivered'))).toBeTruthy();
    expect(screen.getByText(t('web.ticket_delivery_unconfirmed'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('web.ticket_attachment_download') })).toBeTruthy();
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
