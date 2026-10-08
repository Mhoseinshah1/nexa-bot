import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { BROADCAST_LARGE_AUDIENCE } from '@nexa/contracts';
import { NAV, navPermitted } from '../../apps/web/src/app';
import {
  BroadcastDetailPage,
  BroadcastsPage,
  renderBroadcastPreview,
} from '../../apps/web/src/pages/broadcasts';
import { renderPage, stubApi } from './harness';

/**
 * «ارسال همگانی» in the Web Admin (round N, B1): the list, the confirmation that binds to the
 * previewed count and set, the stronger confirmation for a very large send, and the report's
 * steering. Rendered through the real client and the real response schemas.
 */

const ID = '019280ab-cdef-7012-8345-6789abcdef01';
const HASH = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(32);

function broadcast(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    title: 'Nowruz',
    state: 'DRAFT',
    pauseReason: null,
    contentKind: 'TEXT',
    body: 'سلام {firstName}',
    buttons: [],
    media: null,
    purpose: 'MARKETING',
    source: null,
    sourceVerifiedAt: null,
    pin: false,
    frozenAudienceId: null,
    audience: { version: 1, customerStatus: 'ACTIVE', purchase: 'PURCHASED' },
    audienceHash: HASH,
    audienceAsOf: null,
    recipientCount: null,
    fingerprint: null,
    scheduledAt: null,
    counts: {
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
    },
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

function preview(customers: number): Record<string, unknown> {
  return {
    preview: {
      asOf: '2026-09-20T10:00:00.000Z',
      definition: { version: 1 },
      definitionHash: HASH,
      customers,
      reachable: customers,
      fingerprint: FINGERPRINT,
      sample: [],
    },
  };
}

const OPTIONS = {
  url: '/audience/options',
  body: { currency: 'IRT', resellerTiers: [], products: [], panels: [], tags: [] },
};

describe('broadcast in the Web Admin', () => {
  it('is reached on broadcasts.view', () => {
    const entry = NAV.find((candidate) => candidate.id === 'broadcasts');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(navPermitted(entry, ['broadcasts.view'])).toBe(true);
    expect(navPermitted(entry, ['users.view'])).toBe(false);
  });

  it('lists broadcasts with their state and progress', async () => {
    stubApi([
      {
        url: '/broadcasts',
        body: {
          broadcasts: [broadcast({ state: 'SENDING', progressPercent: 40, recipientCount: 10 })],
          nextCursor: null,
        },
      },
    ]);
    renderPage(
      <BroadcastsPage
        route={{ path: '/broadcasts', query: new URLSearchParams() }}
        denied={false}
        maySend
      />,
    );
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Nowruz').closest('a')).toHaveAttribute(
      'href',
      `/broadcasts/${ID}`,
    );
    expect(within(table).getByText('در حال ارسال')).toBeInTheDocument();
    expect(within(table).getByText(/40%|۴۰%/u)).toBeInTheDocument();
  });

  it('renders the preview with the bot’s renderer and the placeholder catalogue', () => {
    expect(renderBroadcastPreview('سلام {firstName}\n@{username}')).toBe('سلام سارا\n@sample_user');
    // A token outside the catalogue is left as written, never silently filled.
    expect(renderBroadcastPreview('{subscriptionUrl}')).toBe('{subscriptionUrl}');
  });

  it('launches only after the count is taken and confirmed, binding to what was previewed', async () => {
    const api = stubApi([
      OPTIONS,
      { url: `/broadcasts/${ID}`, body: { broadcast: broadcast() } },
      { url: `/broadcasts/${ID}/preview`, body: preview(12) },
      { url: `/broadcasts/${ID}/launch`, body: { broadcast: broadcast({ state: 'SENDING' }) } },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    fireEvent.click(await screen.findByRole('button', { name: 'شمارش دقیق گیرندگان' }));
    const send = await screen.findByRole('button', { name: 'ارسال همین حالا' });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/ارسال را تأیید می‌کنم/u));
    expect(send).not.toBeDisabled();
    fireEvent.click(send);
    // The last question is asked in a dialog; nothing is sent until it is answered.
    expect(api.calls.some((call) => call.url.endsWith('/launch'))).toBe(false);
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'بله، ارسال شود' }),
    );
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith(`/broadcasts/${ID}/launch`))).toBe(true),
    );
    const launch = api.calls.find((call) => call.url.endsWith('/launch'));
    expect(launch?.body).toMatchObject({
      mode: 'NOW',
      expectedVersion: 3,
      expectedDefinitionHash: HASH,
      expectedRecipients: 12,
      expectedFingerprint: FINGERPRINT,
      typedCount: null,
      confirmed: true,
    });
  });

  it('asks a very large send to type its count back', async () => {
    stubApi([
      OPTIONS,
      { url: `/broadcasts/${ID}`, body: { broadcast: broadcast() } },
      { url: `/broadcasts/${ID}/preview`, body: preview(BROADCAST_LARGE_AUDIENCE + 5) },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    fireEvent.click(await screen.findByRole('button', { name: 'شمارش دقیق گیرندگان' }));
    const send = await screen.findByRole('button', { name: 'ارسال همین حالا' });
    fireEvent.click(screen.getByLabelText(/ارسال را تأیید می‌کنم/u));
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/تعداد گیرندگان را دقیقاً وارد کنید/u), {
      target: { value: String(BROADCAST_LARGE_AUDIENCE + 5) },
    });
    expect(send).not.toBeDisabled();
  });

  it('reports delivery and steers a sending broadcast; cancel asks first', async () => {
    const api = stubApi([
      {
        url: `/broadcasts/${ID}`,
        body: {
          broadcast: broadcast({
            state: 'SENDING',
            recipientCount: 10,
            fingerprint: FINGERPRINT,
            audienceAsOf: '2026-09-20T10:00:00.000Z',
            progressPercent: 50,
            counts: {
              total: 10,
              pending: 5,
              sending: 0,
              sent: 3,
              unconfirmed: 0,
              failed: 1,
              unreachable: 1,
              skipped: 0,
              cancelled: 0,
              pinned: 0,
              pinFailed: 0,
            },
          }),
        },
      },
      { url: `/broadcasts/${ID}/recipients`, body: { recipients: [], nextCursor: null } },
      {
        url: `/broadcasts/${ID}/pause`,
        body: { broadcast: broadcast({ state: 'PAUSED', pauseReason: 'OPERATOR' }) },
      },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    expect(await screen.findByText('گزارش تحویل')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'توقف موقت' }));
    await waitFor(() => expect(api.calls.some((call) => call.url.endsWith('/pause'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'لغو باقی‌ماندهٔ ارسال' }));
    expect(api.calls.some((call) => call.url.endsWith('/cancel'))).toBe(false);
    expect(screen.getByRole('button', { name: 'بله، لغو شود' })).toBeInTheDocument();
  });

  // Codex R5 on PR #117: a media change bumps the version and remounts the composer, so it
  // is refused while the composer holds unsaved edits rather than silently dropping them.
  it('blocks media changes while the composer holds unsaved edits', async () => {
    stubApi([
      OPTIONS,
      {
        url: `/broadcasts/${ID}`,
        body: {
          broadcast: broadcast({
            contentKind: 'PHOTO',
            body: '',
            media: {
              mimeType: 'image/png',
              fileName: 'offer.png',
              byteLength: 10,
              available: true,
            },
          }),
        },
      },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    const picker = await screen.findByLabelText('انتخاب فایل');
    const remove = screen.getByRole('button', { name: 'حذف فایل' });
    expect(picker).not.toBeDisabled();
    expect(remove).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('عنوان (فقط برای مدیران)'), {
      target: { value: 'Edited' },
    });
    expect(picker).toBeDisabled();
    expect(remove).toBeDisabled();
    expect(screen.getByText(/ابتدا تغییرات پیش‌نویس را ذخیره کنید/u)).toBeInTheDocument();
    // Undoing the edit is not dirty any more.
    fireEvent.change(screen.getByLabelText('عنوان (فقط برای مدیران)'), {
      target: { value: 'Nowruz' },
    });
    expect(picker).not.toBeDisabled();
  });

  // Codex R6 on PR #117: the recipients are read again with the detail while sending.
  it('refreshes the recipients while the broadcast is sending', async () => {
    const api = stubApi([
      {
        url: `/broadcasts/${ID}`,
        body: { broadcast: broadcast({ state: 'SENDING', recipientCount: 2 }) },
      },
      { url: `/broadcasts/${ID}/recipients`, body: { recipients: [], nextCursor: null } },
    ]);
    const reads = () => api.calls.filter((call) => call.url.includes('/recipients')).length;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
      await waitFor(() => expect(reads()).toBe(1));
      await vi.advanceTimersByTimeAsync(5_500);
      await waitFor(() => expect(reads()).toBeGreaterThanOrEqual(2));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a draft that moved on while it was being edited (PR #245, Codex CX2 and review M1)', () => {
  const conflict = {
    error: {
      kind: 'CONFLICT',
      code: 'broadcast.version_conflict',
      message: 'The draft changed.',
      correlationId: 'test',
    },
  };

  /** The server's draft: v3 until a save is refused, v4 (another operator's text) after. */
  function moving() {
    let refused = false;
    const routes = [
      OPTIONS,
      {
        url: `/broadcasts/${ID}/draft`,
        status: 409,
        get body() {
          refused = true;
          return conflict;
        },
      },
      {
        url: `/broadcasts/${ID}`,
        get body() {
          return {
            broadcast: refused
              ? broadcast({ version: 4, body: 'متن همکار' })
              : broadcast({ version: 3 }),
          };
        },
      },
    ];
    return routes;
  }

  const drafts = () => document.querySelectorAll('#bc-body');

  it('keeps the operator’s text after a 409, with ONE editor, and asks before replacing it', async () => {
    const api = stubApi(moving());
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    const reads = () =>
      api.calls.filter((call) => call.method === 'GET' && call.url.endsWith(`/broadcasts/${ID}`))
        .length;
    const body = (await screen.findByLabelText('متن پیام')) as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: 'متن من' } });
    const before = reads();
    fireEvent.click(screen.getByRole('button', { name: 'ذخیرهٔ تغییرات' }));
    // The 409 re-reads the draft (the onConflict the web foundation added).
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(
      (await screen.findAllByText(/این پیش‌نویس در این فاصله تغییر کرده است/)).length,
    ).toBeGreaterThan(0);
    // One editor, still holding what the operator typed.
    expect(drafts()).toHaveLength(1);
    expect((drafts()[0] as HTMLTextAreaElement).value).toBe('متن من');
    // Save waits for the choice; loading the latest replaces the text only when asked.
    expect(screen.getByRole('button', { name: 'ذخیرهٔ تغییرات' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /بارگذاری نسخهٔ تازه/ }));
    await waitFor(() => expect((drafts()[0] as HTMLTextAreaElement).value).toBe('متن همکار'));
    expect(drafts()).toHaveLength(1);
  });

  it('keeps the operator’s text on the latest version when they choose to, and saves against it', async () => {
    const api = stubApi(moving());
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    const body = (await screen.findByLabelText('متن پیام')) as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: 'متن من' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیرهٔ تغییرات' }));
    fireEvent.click(await screen.findByRole('button', { name: /نگه‌داشتن تغییرات من/ }));
    expect((drafts()[0] as HTMLTextAreaElement).value).toBe('متن من');
    fireEvent.click(screen.getByRole('button', { name: 'ذخیرهٔ تغییرات' }));
    await waitFor(() =>
      expect(
        api.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/draft')),
      ).toHaveLength(2),
    );
    const second = api.calls.filter((call) => call.url.endsWith('/draft'))[1];
    expect(second?.body).toMatchObject({ expectedVersion: 4, body: 'متن من' });
  });

  it('sends no audience key at its default, so an older server accepts the save (review m3)', async () => {
    const api = stubApi([
      OPTIONS,
      { url: `/broadcasts/${ID}/draft`, body: { broadcast: broadcast({ version: 4 }) } },
      { url: `/broadcasts/${ID}`, body: { broadcast: broadcast() } },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    fireEvent.change(await screen.findByLabelText('متن پیام'), { target: { value: 'تازه' } });
    fireEvent.click(screen.getByRole('button', { name: 'ذخیرهٔ تغییرات' }));
    await waitFor(() => expect(api.calls.some((call) => call.url.endsWith('/draft'))).toBe(true));
    const audience = (
      api.calls.find((call) => call.url.endsWith('/draft'))?.body as {
        audience: Record<string, unknown>;
      }
    ).audience;
    expect(Object.keys(audience)).not.toContain('botInstanceIds');
    expect(Object.keys(audience)).not.toContain('tags');
    expect(Object.keys(audience)).not.toContain('activeService');
  });

  it('re-reads the draft when a launch is refused as stale (409)', async () => {
    const api = stubApi([
      OPTIONS,
      { url: `/broadcasts/${ID}/preview`, body: preview(12) },
      { url: `/broadcasts/${ID}/launch`, status: 409, body: conflict },
      { url: `/broadcasts/${ID}`, body: { broadcast: broadcast() } },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    const reads = () =>
      api.calls.filter((call) => call.method === 'GET' && call.url.endsWith(`/broadcasts/${ID}`))
        .length;
    fireEvent.click(await screen.findByRole('button', { name: 'شمارش دقیق گیرندگان' }));
    const send = await screen.findByRole('button', { name: 'ارسال همین حالا' });
    fireEvent.click(screen.getByLabelText(/ارسال را تأیید می‌کنم/u));
    fireEvent.click(send);
    const before = reads();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'بله، ارسال شود' }),
    );
    await waitFor(() => expect(api.calls.some((call) => call.url.endsWith('/launch'))).toBe(true));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
  });
});
