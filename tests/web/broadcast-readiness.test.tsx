import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { BroadcastDetailPage, broadcastReasonLabel } from '../../apps/web/src/pages/broadcasts';
import { renderPage, stubApi } from './harness';

/** Holds every request whose URL contains `path` until `release` is called. */
function holdRequests(path: string): { release: () => void } {
  const inner = globalThis.fetch;
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  vi.stubGlobal('fetch', (input: unknown, init?: RequestInit) =>
    String(input).includes(path)
      ? gate.then(() => inner(input as string, init))
      : inner(input as string, init),
  );
  return { release: () => open() };
}

/**
 * Roadmap C2 — the broadcast operator's page: delivery per bot, the broadcast's own history,
 * every test outcome in its own words, a test that never reads unsaved edits, failure reasons
 * in words beside their codes, a waiting retry's next attempt, and a re-queue that is asked
 * first. Rendered through the real client and response schemas.
 */

const ID = '019280ab-cdef-7012-8345-6789abcdef01';
const BOT_A = '019280ab-cdef-7012-8345-0000000000a1';
const BOT_B = '019280ab-cdef-7012-8345-0000000000a2';
const HASH = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(32);
const T_SENT = 'پیام آزمایشی به تلگرام شما فرستاده شد.';

const ZERO = {
  total: 0,
  pending: 0,
  sending: 0,
  sent: 0,
  unconfirmed: 0,
  failed: 0,
  unreachable: 0,
  skipped: 0,
  cancelled: 0,
  pinned: 0,
  pinFailed: 0,
};

const OPTIONS = {
  url: '/audience/options',
  body: { currency: 'IRT', resellerTiers: [], products: [], panels: [], tags: [] },
};

function broadcast(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    title: 'Nowruz',
    state: 'DRAFT',
    pauseReason: null,
    contentKind: 'TEXT',
    body: 'سلام',
    buttons: [],
    media: null,
    purpose: 'MARKETING',
    source: null,
    sourceVerifiedAt: null,
    pin: false,
    frozenAudienceId: null,
    audience: { version: 1 },
    audienceHash: HASH,
    audienceAsOf: null,
    recipientCount: null,
    fingerprint: null,
    scheduledAt: null,
    counts: ZERO,
    progressPercent: null,
    version: 3,
    createdBy: { id: 'x', username: 'owner' },
    launchedBy: null,
    createdAt: '2026-09-20T10:00:00.000Z',
    launchedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

const sending = (counts: Record<string, number>) =>
  broadcast({
    state: 'SENDING',
    recipientCount: 10,
    fingerprint: FINGERPRINT,
    audienceAsOf: '2026-09-20T10:00:00.000Z',
    launchedAt: '2026-09-20T10:00:00.000Z',
    startedAt: '2026-09-20T10:00:00.000Z',
    progressPercent: 50,
    counts: { ...ZERO, ...counts },
  });

const historyEntry = (overrides: Record<string, unknown>) => ({
  id: `019280ab-cdef-7012-8345-${String(Math.random()).slice(2, 14).padEnd(12, '0')}`,
  action: 'broadcast.test',
  result: 'SUCCESS',
  actorLabel: 'owner',
  occurredAt: '2026-09-20T09:00:00.000Z',
  testOutcome: null,
  requeued: null,
  fromState: null,
  toState: null,
  ...overrides,
});

describe('broadcast delivery per bot', () => {
  it('shows each bot’s own delivery, its 429 hold, a bot that cannot send, and the recipients with no bot', async () => {
    stubApi([
      {
        url: `/broadcasts/${ID}`,
        body: { broadcast: sending({ total: 10, sent: 5, pending: 3, failed: 1, unreachable: 1 }) },
      },
      { url: `/broadcasts/${ID}/recipients`, body: { recipients: [], nextCursor: null } },
      { url: `/broadcasts/${ID}/failures`, body: { reasons: [] } },
      { url: `/broadcasts/${ID}/history`, body: { entries: [] } },
      {
        url: `/broadcasts/${ID}/bots`,
        body: {
          bots: [
            {
              botInstanceId: BOT_A,
              botUsername: 'shop_bot',
              botStatus: 'ACTIVE',
              counts: { ...ZERO, total: 6, sent: 5, pending: 1 },
              waitingRetry: 1,
              heldUntil: '2099-01-01T00:00:00.000Z',
            },
            {
              botInstanceId: BOT_B,
              botUsername: 'support_bot',
              botStatus: 'DISABLED',
              counts: { ...ZERO, total: 3, pending: 2, failed: 1 },
              waitingRetry: 2,
              heldUntil: null,
            },
            {
              botInstanceId: null,
              botUsername: null,
              botStatus: null,
              counts: { ...ZERO, total: 1, unreachable: 1 },
              waitingRetry: 0,
              heldUntil: null,
            },
          ],
        },
      },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    const table = await screen.findByRole('table', { name: 'تحویل به تفکیک ربات' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    // Each bot by its own name; the held one says until when; the disabled one says so.
    expect(rows[0]?.textContent).toContain('@shop_bot');
    expect(rows[0]?.textContent).toContain('5 / 6');
    expect(within(rows[0] as HTMLElement).getByText(/^تا /)).toBeInTheDocument();
    expect(rows[1]?.textContent).toContain('@support_bot');
    expect(within(rows[1] as HTMLElement).getByText('غیرفعال')).toBeInTheDocument();
    expect(rows[1]?.textContent).not.toContain('تا ');
    // The recipients recorded with no bot are their own row, never folded into a bot's.
    expect(rows[2]?.textContent).toContain('بدون ربات ثبت‌شده');
  });
});

describe('the broadcast’s own history', () => {
  it('lists tests with what Telegram answered, the launch, and each re-queue with its count; a refusal is marked', async () => {
    stubApi([
      { url: `/broadcasts/${ID}`, body: { broadcast: sending({ total: 10, sent: 10 }) } },
      { url: `/broadcasts/${ID}/recipients`, body: { recipients: [], nextCursor: null } },
      { url: `/broadcasts/${ID}/failures`, body: { reasons: [] } },
      { url: `/broadcasts/${ID}/bots`, body: { bots: [] } },
      {
        url: `/broadcasts/${ID}/history`,
        body: {
          entries: [
            historyEntry({ action: 'broadcast.retry_failed', requeued: 4, fromState: 'COMPLETED' }),
            historyEntry({ action: 'broadcast.pause', result: 'DENIED' }),
            historyEntry({ action: 'broadcast.launch', fromState: 'DRAFT', toState: 'SENDING' }),
            historyEntry({ action: 'broadcast.test', testOutcome: 'UNCONFIRMED' }),
          ],
        },
      },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    expect(await screen.findByText(/4 گیرنده دوباره در صف/)).toBeInTheDocument();
    expect(screen.getByText('رد شد')).toBeInTheDocument();
    expect(screen.getByText('تأیید و شروع')).toBeInTheDocument();
    expect(screen.getByText(/پاسخ تلگرام نامشخص بود/)).toBeInTheDocument();
  });
});

describe('the composer’s test and count', () => {
  it('says each test outcome in its own words, and an unconfirmed test is never called sent', async () => {
    stubApi([
      OPTIONS,
      { url: `/broadcasts/${ID}`, body: { broadcast: broadcast() } },
      { url: `/broadcasts/${ID}/history`, body: { entries: [] } },
      { url: `/broadcasts/${ID}/test`, body: { outcome: 'UNCONFIRMED' } },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    fireEvent.click(await screen.findByRole('button', { name: 'ارسال آزمایشی به تلگرام من' }));
    // Kept on the card as the last answer, not only in a toast that is gone before it is read.
    const status = await screen.findByText(/نتیجهٔ آخرین ارسال آزمایشی/);
    expect(status.textContent).toContain('پاسخ تلگرام نامشخص بود');
    expect(status.textContent).not.toContain(T_SENT);
  });

  it('withholds the test and the count while the composer holds unsaved edits', async () => {
    const api = stubApi([
      OPTIONS,
      { url: `/broadcasts/${ID}`, body: { broadcast: broadcast() } },
      { url: `/broadcasts/${ID}/history`, body: { entries: [] } },
      { url: `/broadcasts/${ID}/test`, body: { outcome: 'SENT' } },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    const test = await screen.findByRole('button', { name: 'ارسال آزمایشی به تلگرام من' });
    expect(test).toBeEnabled();
    fireEvent.change(screen.getByLabelText('عنوان (فقط برای مدیران)'), {
      target: { value: 'Edited' },
    });
    await waitFor(() => expect(test).toBeDisabled());
    expect(screen.getByRole('button', { name: 'شمارش دقیق گیرندگان' })).toBeDisabled();
    expect(screen.getAllByText(/تغییرات ذخیره‌نشده دارید/).length).toBeGreaterThan(0);
    fireEvent.click(test);
    expect(api.calls.some((call) => call.url.includes('/test'))).toBe(false);
  });

  it('shows when a source was verified and that each bot sends its own recipients', async () => {
    stubApi([
      OPTIONS,
      {
        url: `/broadcasts/${ID}`,
        body: {
          broadcast: broadcast({
            contentKind: 'COPY',
            body: '',
            source: { chatId: '-1001234567890', messageId: 42 },
            sourceVerifiedAt: '2026-09-20T09:30:00.000Z',
          }),
        },
      },
      { url: `/broadcasts/${ID}/history`, body: { entries: [] } },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    expect(
      await screen.findByText(/پیش‌نمایش با موفقیت از این مبدأ به شما رسید \(/),
    ).toBeInTheDocument();
    expect(screen.getByText(/هر گیرنده از ربات خودش پیام می‌گیرد/)).toBeInTheDocument();
  });

  it('counts the members with no bot apart from the reachable ones', async () => {
    stubApi([
      OPTIONS,
      { url: `/broadcasts/${ID}`, body: { broadcast: broadcast() } },
      { url: `/broadcasts/${ID}/history`, body: { entries: [] } },
      {
        url: `/broadcasts/${ID}/preview`,
        body: {
          preview: {
            asOf: '2026-09-20T10:00:00.000Z',
            definition: { version: 1 },
            definitionHash: HASH,
            customers: 12,
            reachable: 9,
            fingerprint: FINGERPRINT,
            optedOut: null,
            sample: [],
          },
        },
      },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    fireEvent.click(await screen.findByRole('button', { name: 'شمارش دقیق گیرندگان' }));
    expect(await screen.findByText('بدون ربات (نمی‌رسد)')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });
});

describe('failures and retries', () => {
  it('names a failure in words beside its code, and an opt-out is never called a block', async () => {
    expect(broadcastReasonLabel('broadcast.marketing_opted_out')).toBe(
      'مشتری از پیام‌های تبلیغاتی انصراف داده است',
    );
    expect(broadcastReasonLabel('telegram.server_error.502')).toContain('نامشخص');
    expect(broadcastReasonLabel('something.new')).toBeNull();
    stubApi([
      {
        url: `/broadcasts/${ID}`,
        body: { broadcast: sending({ total: 3, skipped: 1, failed: 1, pending: 1 }) },
      },
      { url: `/broadcasts/${ID}/bots`, body: { bots: [] } },
      { url: `/broadcasts/${ID}/history`, body: { entries: [] } },
      {
        url: `/broadcasts/${ID}/failures`,
        body: {
          reasons: [
            { state: 'SKIPPED', errorCode: 'broadcast.marketing_opted_out', count: 1 },
            { state: 'FAILED', errorCode: 'something.new', count: 1 },
          ],
        },
      },
      {
        url: `/broadcasts/${ID}/recipients`,
        body: {
          recipients: [
            {
              customerId: '019280ab-cdef-7012-8345-00000000d001',
              firstName: 'Sara',
              username: null,
              state: 'PENDING',
              attempts: 0,
              errorCode: 'telegram.rate_limited',
              resolvedAt: null,
              pinState: null,
              pinErrorCode: null,
              nextAttemptAt: '2026-09-20T10:05:00.000Z',
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    const table = await screen.findByRole('table', { name: 'علت‌های نرسیدن' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('مشتری از پیام‌های تبلیغاتی انصراف داده است');
    expect(rows[0]?.textContent).toContain('broadcast.marketing_opted_out');
    expect(rows[0]?.textContent).not.toContain('کاربر مسدود است');
    // An unknown code is shown as it is, never dropped.
    expect(rows[1]?.textContent).toContain('something.new');
    // A deferred recipient says when it is due again.
    const recipients = await screen.findByRole('table', { name: 'گیرندگان' });
    expect(await within(recipients).findByText(/تلاش بعدی:/)).toBeInTheDocument();
    expect(within(recipients).getByText(/محدودیت سرعت تلگرام/)).toBeInTheDocument();
  });

  it('asks before a re-queue, says what is never re-sent, and a cancelled question sends nothing', async () => {
    const api = stubApi([
      { url: `/broadcasts/${ID}`, body: { broadcast: sending({ total: 10, sent: 7, failed: 3 }) } },
      { url: `/broadcasts/${ID}/recipients`, body: { recipients: [], nextCursor: null } },
      { url: `/broadcasts/${ID}/failures`, body: { reasons: [] } },
      { url: `/broadcasts/${ID}/bots`, body: { bots: [] } },
      { url: `/broadcasts/${ID}/history`, body: { entries: [] } },
      {
        url: `/broadcasts/${ID}/retry-failed`,
        body: { broadcast: sending({ total: 10, sent: 7, pending: 3 }) },
      },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    const retried = () => api.calls.filter((call) => call.url.includes('/retry-failed')).length;
    fireEvent.click(await screen.findByRole('button', { name: 'ارسال دوباره به ناموفق‌ها (3)' }));
    expect(await screen.findByText(/3 گیرندهٔ ناموفق دوباره در صف/)).toBeInTheDocument();
    expect(screen.getByText(/«نامشخص»ها \(شاید رسیده باشند\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'بازگشت' }));
    expect(retried()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'ارسال دوباره به ناموفق‌ها (3)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'بله، دوباره در صف بگذار' }));
    await waitFor(() => expect(retried()).toBe(1));
  });

  it('takes a steer once: the buttons wait while one is in flight', async () => {
    const api = stubApi([
      {
        url: `/broadcasts/${ID}`,
        body: { broadcast: sending({ total: 10, sent: 5, pending: 4, failed: 1 }) },
      },
      { url: `/broadcasts/${ID}/recipients`, body: { recipients: [], nextCursor: null } },
      { url: `/broadcasts/${ID}/failures`, body: { reasons: [] } },
      { url: `/broadcasts/${ID}/bots`, body: { bots: [] } },
      { url: `/broadcasts/${ID}/history`, body: { entries: [] } },
      { url: `/broadcasts/${ID}/pause`, body: { broadcast: sending({ total: 10 }) } },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    const pause = await screen.findByRole('button', { name: 'توقف موقت' });
    const held = holdRequests('/pause');
    fireEvent.click(pause);
    // While the first is in flight every command button waits; a second click sends nothing.
    await waitFor(() => expect(pause).toBeDisabled());
    fireEvent.click(pause);
    expect(screen.getByRole('button', { name: 'لغو باقی‌ماندهٔ ارسال' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ارسال دوباره به ناموفق‌ها (1)' })).toBeDisabled();
    held.release();
    await waitFor(() =>
      expect(api.calls.filter((call) => call.url.includes('/pause')).length).toBe(1),
    );
  });
});
