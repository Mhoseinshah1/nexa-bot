import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type * as TicketsModule from '../../apps/web/src/pages/tickets';
import type { PickedReplyFile } from '../../apps/web/src/pages/tickets';
import { UserDetailPage } from '../../apps/web/src/pages/users';
import { customer, renderPage, stubApi } from './harness';

/*
 * The file read, held open by the test: each pick's `readReplyFile` resolves only when the
 * test says so, so a read can be made to complete AFTER the file was cleared or replaced —
 * the order a large file and a quick operator produce. Off (`held === null`), the real read.
 */
const reads = vi.hoisted(() => ({
  held: null as null | Map<string, (result: unknown) => void>,
}));
vi.mock('../../apps/web/src/pages/tickets', async (importOriginal) => {
  const original = await importOriginal<typeof TicketsModule>();
  return {
    ...original,
    readReplyFile: (file: File) => {
      const held = reads.held;
      if (held === null) return original.readReplyFile(file);
      return new Promise((resolve) => held.set(file.name, resolve));
    },
  };
});
afterEach(() => {
  reads.held = null;
});

const readyFile = (fileName: string): PickedReplyFile => ({
  kind: 'READY',
  attachment: { fileName, mimeType: 'application/pdf', contentBase64: 'JVBERi0xLjcK' },
  byteLength: 9,
});

/**
 * Phase A2 — «ارسال پیام» on Customer 360, rendered against the shapes the server returns
 * (every fixture is parsed by the contract's schema on its way through the real client).
 *
 * The owner-visible rules: the control and the history are each drawn only under their own
 * permission; a message is written, PREVIEWED and only then sent by an explicit confirmation,
 * with an idempotency key; a blocked customer cannot be written to from the page; the
 * delivery states say what Telegram said and never "delivered" or "read"; and the server's
 * refusals arrive as Persian sentences.
 */

const ID = '019210ab-cdef-7012-8345-6789abcdef01';
const OFF = {
  mayBlock: false,
  mayViewWallet: false,
  mayCredit: false,
  mayDebit: false,
  mayViewOrders: false,
  mayViewServices: false,
  mayEditTrial: false,
  mayViewReferrals: false,
  mayViewReseller: false,
  mayEditReseller: false,
} as const;

const overview = {
  overview: {
    customerId: ID,
    channelMembershipExemptAt: null,
    phone: null,
    locationOverride: null,
    marketingOptOutAt: null,
    terms: { available: false },
  },
};

const message = (overrides: Record<string, unknown> = {}) => ({
  id: '019210ab-cdef-7012-8345-000000000001',
  contentKind: 'TEXT',
  text: 'پرداخت شما تأیید شد.',
  file: null,
  sentBy: { id: '019210ab-cdef-7012-8345-0000000000aa', username: 'support-maryam' },
  createdAt: '2026-10-03T08:00:00.000Z',
  delivery: 'SENT',
  attempts: 0,
  resolvedAt: '2026-10-03T08:00:30.000Z',
  ...overrides,
});

const routes = (
  extra: readonly { url: string; body: unknown; status?: number }[] = [],
  row = customer(),
) => [
  { url: `/users/${ID}`, body: { customer: row } },
  { url: `/users/${ID}/overview`, body: overview },
  {
    url: `/users/${ID}/trial`,
    body: {
      trial: {
        customerId: ID,
        featureEnabled: true,
        globalLimit: 1,
        override: null,
        effectiveLimit: 1,
        used: 0,
        remaining: 1,
      },
    },
  },
  ...extra,
];

describe('Phase A2 — direct message on Customer 360', () => {
  it('draws neither the button nor the history without their permissions, and asks nothing', async () => {
    const api = stubApi(routes());
    renderPage(<UserDetailPage id={ID} {...OFF} denied={false} />);
    await screen.findByText('محدودیت‌ها و کنترل‌ها', { selector: 'h2' });
    expect(screen.queryByRole('button', { name: 'ارسال پیام' })).toBeNull();
    expect(screen.queryByText('پیام‌های مستقیم')).toBeNull();
    expect(api.calls.some((call) => call.url.includes('/direct-messages'))).toBe(false);
  });

  it('lists the history with honest delivery states, and offers no send without users.message.send', async () => {
    stubApi(
      routes([
        {
          url: `/users/${ID}/direct-messages`,
          body: {
            messages: [
              message(),
              message({
                id: '019210ab-cdef-7012-8345-000000000002',
                delivery: 'UNKNOWN',
                text: 'لطفاً دوباره تلاش کنید.',
              }),
              message({
                id: '019210ab-cdef-7012-8345-000000000003',
                contentKind: 'PHOTO',
                text: null,
                file: { fileName: 'guide.png', mimeType: 'image/png', byteLength: 1200 },
                delivery: 'QUEUED',
                attempts: 1,
              }),
            ],
            nextCursor: null,
          },
        },
      ]),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} mayViewMessages denied={false} />);
    const card = (await screen.findByText('پیام‌های مستقیم', { selector: 'h2' })).closest(
      '.card',
    ) as HTMLElement;
    await within(card).findByText('پرداخت شما تأیید شد.');
    expect(within(card).getByText('پذیرفته‌شده توسط تلگرام')).toBeTruthy();
    expect(within(card).getByText('نتیجه نامعلوم')).toBeTruthy();
    expect(
      within(card).getByText(
        'ممکن است مشتری پیام را گرفته باشد یا نگرفته باشد. برای جلوگیری از پیام تکراری، خودکار دوباره فرستاده نمی‌شود.',
      ),
    ).toBeTruthy();
    expect(within(card).getByText('guide.png')).toBeTruthy();
    // Telegram tells a bot it accepted a message, nothing more: no state claims more than that.
    expect(within(card).queryByText(/^(تحویل|خوانده|رسید)/u)).toBeNull();
    expect(screen.queryByRole('button', { name: 'ارسال پیام' })).toBeNull();
  });

  it('writes, previews and only then sends — once, with an idempotency key', async () => {
    const api = stubApi(
      routes([{ url: `/users/${ID}/direct-messages`, body: { messages: [], nextCursor: null } }]),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} mayMessage mayViewMessages denied={false} />);
    const [open] = await screen.findAllByRole('button', { name: 'ارسال پیام' });
    fireEvent.click(open as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    const preview = within(dialog).getByRole('button', { name: 'پیش‌نمایش' });
    expect(preview).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('متن پیام'), {
      target: { value: 'سرویس شما تمدید شد.' },
    });
    fireEvent.click(preview);
    // The preview shows what the customer will read, and nothing has been sent yet.
    await within(dialog).findByText('پیام پشتیبانی');
    expect(within(dialog).getByText('سرویس شما تمدید شد.')).toBeTruthy();
    expect(api.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('sends the confirmed message with its key and the text, and says it is queued', async () => {
    const api = stubApi(
      routes([
        {
          url: `/users/${ID}/direct-messages`,
          body: { message: message({ delivery: 'QUEUED', resolvedAt: null }), replayed: false },
        },
      ]),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} mayMessage denied={false} />);
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'ارسال پیام' }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('متن پیام'), {
      target: { value: 'سرویس شما تمدید شد.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'پیش‌نمایش' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'تأیید و ارسال' }));
    await screen.findByText('پیام در صف ارسال قرار گرفت.');
    const posts = api.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain(`/users/${ID}/direct-messages`);
    expect(posts[0]?.body).toMatchObject({ text: 'سرویس شما تمدید شد.', file: null });
    expect(typeof (posts[0]?.body as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
  });

  it('turns the server’s rate limit into a Persian sentence and keeps the draft', async () => {
    stubApi(
      routes([
        {
          url: `/users/${ID}/direct-messages`,
          status: 429,
          body: {
            error: {
              kind: 'RATE_LIMITED',
              code: 'direct_message.rate_limited',
              message: 'This customer was sent too many direct messages recently.',
              correlationId: 'c',
              details: { scope: 'CUSTOMER', max: 5, windowMs: 600000 },
            },
          },
        },
      ]),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} mayMessage denied={false} />);
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'ارسال پیام' }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('متن پیام'), { target: { value: 'سلام' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'پیش‌نمایش' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: 'تأیید و ارسال' }));
    await within(dialog).findByText(
      'به این مشتری در چند دقیقهٔ اخیر پیام‌های زیادی فرستاده شده است. چند دقیقه بعد دوباره تلاش کنید.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'بازگشت به ویرایش' }));
    expect((within(dialog).getByLabelText('متن پیام') as HTMLTextAreaElement).value).toBe('سلام');
  });

  it('cannot write to a blocked customer from the page', async () => {
    stubApi(routes([], customer({ status: 'BLOCKED', blockedAt: '2026-10-01T00:00:00.000Z' })));
    renderPage(<UserDetailPage id={ID} {...OFF} mayMessage denied={false} />);
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'ارسال پیام' }))[0] as HTMLElement,
    );
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('این مشتری مسدود است؛ تا رفع مسدودیت نمی‌توان به او پیام داد.'),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('متن پیام'), { target: { value: 'سلام' } });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'پیش‌نمایش' })).toBeDisabled(),
    );
  });

  async function openComposer() {
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'ارسال پیام' }))[0] as HTMLElement,
    );
    return screen.findByRole('dialog');
  }
  const pick = (dialog: HTMLElement, name: string) =>
    fireEvent.change(within(dialog).getByLabelText('عکس یا فایل (اختیاری)'), {
      target: { files: [new File(['%PDF-1.7'], name, { type: 'application/pdf' })] },
    });
  const finishRead = async (name: string, result: PickedReplyFile) => {
    const resolve = reads.held?.get(name);
    if (resolve === undefined) throw new Error(`no read in flight for ${name}`);
    await act(async () => {
      resolve(result);
      await Promise.resolve();
    });
  };

  it('ignores a file read that completes after the file was removed', async () => {
    reads.held = new Map();
    const api = stubApi(
      routes([
        {
          url: `/users/${ID}/direct-messages`,
          body: { message: message({ delivery: 'QUEUED', resolvedAt: null }), replayed: false },
        },
      ]),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} mayMessage denied={false} />);
    const dialog = await openComposer();
    fireEvent.change(within(dialog).getByLabelText('متن پیام'), { target: { value: 'سلام' } });
    pick(dialog, 'old-invoice.pdf');
    await within(dialog).findByText('در حال خواندن فایل…');
    fireEvent.click(within(dialog).getByRole('button', { name: 'حذف پیوست' }));
    // The removed file's read lands now; it must not bring the file back.
    await finishRead('old-invoice.pdf', readyFile('old-invoice.pdf'));
    expect(within(dialog).queryByRole('button', { name: 'حذف پیوست' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'پیش‌نمایش' }));
    expect(within(dialog).queryByText('old-invoice.pdf')).toBeNull();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'تأیید و ارسال' }));
    await screen.findByText('پیام در صف ارسال قرار گرفت.');
    const posts = api.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({ text: 'سلام', file: null });
  });

  it('keeps the file the operator picked last when an earlier pick’s read completes after it', async () => {
    reads.held = new Map();
    const api = stubApi(
      routes([
        {
          url: `/users/${ID}/direct-messages`,
          body: { message: message({ delivery: 'QUEUED', resolvedAt: null }), replayed: false },
        },
      ]),
    );
    renderPage(<UserDetailPage id={ID} {...OFF} mayMessage denied={false} />);
    const dialog = await openComposer();
    pick(dialog, 'first.pdf');
    pick(dialog, 'second.pdf');
    await finishRead('second.pdf', readyFile('second.pdf'));
    await finishRead('first.pdf', readyFile('first.pdf'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'پیش‌نمایش' }));
    expect(await within(dialog).findByText('second.pdf')).toBeTruthy();
    expect(within(dialog).queryByText('first.pdf')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'تأیید و ارسال' }));
    await screen.findByText('پیام در صف ارسال قرار گرفت.');
    const posts = api.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toMatchObject({ file: { fileName: 'second.pdf' } });
  });

  it('asks before a close drops the draft, and a close that is accepted discards it', async () => {
    stubApi(routes());
    renderPage(<UserDetailPage id={ID} {...OFF} mayMessage denied={false} />);
    let dialog = await openComposer();
    fireEvent.change(within(dialog).getByLabelText('متن پیام'), {
      target: { value: 'متن پیام قبلی' },
    });

    // «انصراف» asks; staying keeps every word.
    fireEvent.click(within(dialog).getByRole('button', { name: 'انصراف' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ماندن و ادامهٔ ویرایش' }));
    expect((within(dialog).getByLabelText('متن پیام') as HTMLTextAreaElement).value).toBe(
      'متن پیام قبلی',
    );

    // The ✕ asks too; discarding closes, and the next compose starts empty.
    fireEvent.click(within(dialog).getByRole('button', { name: 'بستن' }));
    fireEvent.click(await screen.findByRole('button', { name: 'دورانداختن تغییرات' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'ارسال پیام به مشتری' })).toBeNull(),
    );
    dialog = await openComposer();
    expect((within(dialog).getByLabelText('متن پیام') as HTMLTextAreaElement).value).toBe('');
    expect(within(dialog).queryByRole('button', { name: 'حذف پیوست' })).toBeNull();
  });

  it('discards a draft with a file when Escape closes the composer and the discard is confirmed', async () => {
    stubApi(routes());
    renderPage(<UserDetailPage id={ID} {...OFF} mayMessage denied={false} />);
    let dialog = await openComposer();
    fireEvent.change(within(dialog).getByLabelText('متن پیام'), { target: { value: 'پیوست' } });
    pick(dialog, 'receipt.pdf');
    await within(dialog).findByRole('button', { name: 'حذف پیوست' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(await screen.findByRole('button', { name: 'دورانداختن تغییرات' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'ارسال پیام به مشتری' })).toBeNull(),
    );
    dialog = await openComposer();
    expect((within(dialog).getByLabelText('متن پیام') as HTMLTextAreaElement).value).toBe('');
    expect(within(dialog).queryByRole('button', { name: 'حذف پیوست' })).toBeNull();
  });
});
