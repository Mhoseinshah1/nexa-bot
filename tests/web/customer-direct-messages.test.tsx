import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { UserDetailPage } from '../../apps/web/src/pages/users';
import { customer, renderPage, stubApi } from './harness';

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
});
