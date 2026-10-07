import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  AudienceBuilder,
  EMPTY_AUDIENCE,
  describeAudience,
  withTagRole,
  type AudienceDraft,
} from '../../apps/web/src/pages/audience-builder';
import { BroadcastDetailPage } from '../../apps/web/src/pages/broadcasts';
import { renderPage, stubApi } from './harness';

/**
 * Broadcast V2 in the Web Admin (program §19): the tag and active-service dimensions in the
 * ONE audience builder, the opted-out estimate beside the count, and the report's derived
 * outcome and failures-by-reason. Rendered through the real client and response schemas.
 */

const ID = '019280ab-cdef-7012-8345-6789abcdef01';
const HASH = 'a'.repeat(64);
const FINGERPRINT = 'b'.repeat(32);
const VIP = '019280ab-cdef-7012-8345-00000000c001';
const RISK = '019280ab-cdef-7012-8345-00000000c002';
const OLD = '019280ab-cdef-7012-8345-00000000c003';

const OPTIONS = {
  url: '/audience/options',
  body: {
    currency: 'IRT',
    resellerTiers: [],
    products: [],
    panels: [],
    tags: [
      { id: VIP, label: 'مشتری ویژه', archived: false },
      { id: RISK, label: 'پرریسک', archived: false },
      { id: OLD, label: 'قدیمی', archived: true },
    ],
  },
};

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
    audience: { version: 1, tags: { anyOf: [VIP], noneOf: [] }, activeService: 'HAS' },
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

function Harness({ onDraft }: { onDraft: (draft: AudienceDraft) => void }) {
  const [draft, setDraft] = useState<AudienceDraft>(EMPTY_AUDIENCE);
  return (
    <AudienceBuilder
      value={draft}
      onChange={(next) => {
        setDraft(next);
        onDraft(next);
      }}
    />
  );
}

describe('the audience builder, Broadcast V2', () => {
  it('offers each tag as has / has not / either, archived ones marked, by id', async () => {
    stubApi([OPTIONS]);
    let last: AudienceDraft = EMPTY_AUDIENCE;
    renderPage(<Harness onDraft={(draft) => (last = draft)} />);
    const vip = (await screen.findByLabelText('مشتری ویژه')) as HTMLSelectElement;
    expect(screen.getByLabelText('قدیمی (بایگانی‌شده)')).toBeInTheDocument();
    expect(
      within(vip)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['فرقی نمی‌کند', 'دارد', 'ندارد']);
    fireEvent.change(vip, { target: { value: 'ANY_OF' } });
    fireEvent.change(screen.getByLabelText('پرریسک'), { target: { value: 'NONE_OF' } });
    expect(last.tags).toEqual({ anyOf: [VIP], noneOf: [RISK] });
    // Moving a tag to the other list never leaves it in both (the contract refuses that).
    fireEvent.change(vip, { target: { value: 'NONE_OF' } });
    expect(last.tags).toEqual({ anyOf: [], noneOf: [RISK, VIP] });
    // Back to "either" for both: no tag criterion at all, not an empty one.
    fireEvent.change(screen.getByLabelText('مشتری ویژه'), { target: { value: 'IGNORE' } });
    fireEvent.change(screen.getByLabelText('پرریسک'), { target: { value: 'IGNORE' } });
    expect(last.tags).toBeNull();
  });

  it('sets has / has no active service', async () => {
    stubApi([OPTIONS]);
    let last: AudienceDraft = EMPTY_AUDIENCE;
    renderPage(<Harness onDraft={(draft) => (last = draft)} />);
    fireEvent.change(await screen.findByLabelText('سرویس فعال'), { target: { value: 'NONE' } });
    expect(last.activeService).toBe('NONE');
  });

  it('draws no tag section for a tenant with no tags', async () => {
    stubApi([{ ...OPTIONS, body: { ...OPTIONS.body, tags: [] } }]);
    renderPage(<Harness onDraft={() => undefined} />);
    await screen.findByLabelText('سرویس فعال');
    expect(screen.queryByText('برچسب‌ها')).toBeNull();
  });

  it('describes the new dimensions in the report’s sentences', () => {
    const lines = describeAudience({
      version: 1,
      tags: { anyOf: [VIP, RISK], noneOf: [OLD] },
      activeService: 'HAS',
    });
    expect(lines).toContain('سرویس فعال: دارد');
    expect(lines.some((line) => line.startsWith('برچسب‌ها: دارد'))).toBe(true);
    // A definition written before Broadcast V2 has neither key and gains no sentence.
    expect(describeAudience({ version: 1 }).some((line) => line.startsWith('برچسب‌ها'))).toBe(
      false,
    );
  });

  it('keeps a tag in exactly one list', () => {
    expect(withTagRole(null, VIP, 'ANY_OF')).toEqual({ anyOf: [VIP], noneOf: [] });
    expect(withTagRole({ anyOf: [VIP], noneOf: [] }, VIP, 'NONE_OF')).toEqual({
      anyOf: [],
      noneOf: [VIP],
    });
    expect(withTagRole({ anyOf: [], noneOf: [VIP] }, VIP, 'IGNORE')).toBeNull();
  });
});

describe('the broadcast page, Broadcast V2', () => {
  const previewBody = (optedOut: number | null) => ({
    preview: {
      asOf: '2026-09-20T10:00:00.000Z',
      definition: { version: 1 },
      definitionHash: HASH,
      customers: 12,
      reachable: 12,
      fingerprint: FINGERPRINT,
      optedOut,
      sample: [],
    },
  });

  it('shows the opted-out estimate beside the count, only when the server gives one', async () => {
    stubApi([
      OPTIONS,
      { url: `/broadcasts/${ID}`, body: { broadcast: broadcast() } },
      { url: `/broadcasts/${ID}/preview`, body: previewBody(3) },
    ]);
    const { unmount } = renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    fireEvent.click(await screen.findByRole('button', { name: 'شمارش دقیق گیرندگان' }));
    expect(await screen.findByText('لغو اشتراک تبلیغاتی (تخمین)')).toBeInTheDocument();
    unmount();

    stubApi([
      OPTIONS,
      { url: `/broadcasts/${ID}`, body: { broadcast: broadcast() } },
      { url: `/broadcasts/${ID}/preview`, body: previewBody(null) },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    fireEvent.click(await screen.findByRole('button', { name: 'شمارش دقیق گیرندگان' }));
    await screen.findByRole('button', { name: 'ارسال همین حالا' });
    expect(screen.queryByText('لغو اشتراک تبلیغاتی (تخمین)')).toBeNull();
  });

  it('reports a completed broadcast’s outcome and its failures by reason', async () => {
    stubApi([
      {
        url: `/broadcasts/${ID}`,
        body: {
          broadcast: broadcast({
            state: 'COMPLETED',
            recipientCount: 10,
            fingerprint: FINGERPRINT,
            audienceAsOf: '2026-09-20T10:00:00.000Z',
            progressPercent: 100,
            completedAt: '2026-09-20T11:00:00.000Z',
            counts: { ...ZERO, total: 10, sent: 6, failed: 2, unreachable: 1, skipped: 1 },
          }),
        },
      },
      { url: `/broadcasts/${ID}/recipients`, body: { recipients: [], nextCursor: null } },
      {
        url: `/broadcasts/${ID}/failures`,
        body: {
          reasons: [
            { state: 'FAILED', errorCode: 'telegram.rejected.400', count: 2 },
            { state: 'UNREACHABLE', errorCode: 'telegram.rejected.403', count: 1 },
            { state: 'SKIPPED', errorCode: 'broadcast.marketing_opted_out', count: 1 },
          ],
        },
      },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    expect(await screen.findByText('نتیجه: بخشی نرسید')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'علت‌های نرسیدن' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('telegram.rejected.400'),
      expect.stringContaining('telegram.rejected.403'),
      expect.stringContaining('broadcast.marketing_opted_out'),
    ]);
    // Retrying is offered for the refusals, with how many; nothing offers to resend an
    // unconfirmed one.
    expect(
      screen.getByRole('button', { name: 'ارسال دوباره به ناموفق‌ها (2)' }),
    ).toBeInTheDocument();
  });

  it('asks the failure reasons again after a retry on a paused broadcast', async () => {
    const paused = broadcast({
      state: 'PAUSED',
      recipientCount: 10,
      fingerprint: FINGERPRINT,
      audienceAsOf: '2026-09-20T10:00:00.000Z',
      progressPercent: 60,
      counts: { ...ZERO, total: 10, sent: 4, failed: 2, pending: 4 },
    });
    const api = stubApi([
      { url: `/broadcasts/${ID}`, body: { broadcast: paused } },
      { url: `/broadcasts/${ID}/recipients`, body: { recipients: [], nextCursor: null } },
      {
        url: `/broadcasts/${ID}/failures`,
        body: { reasons: [{ state: 'FAILED', errorCode: 'telegram.rejected.400', count: 2 }] },
      },
      { url: `/broadcasts/${ID}/retry-failed`, body: { broadcast: paused } },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    await screen.findByRole('table', { name: 'علت‌های نرسیدن' });
    const asked = () => api.calls.filter((c) => c.url.includes('/failures')).length;
    const before = asked();
    fireEvent.click(screen.getByRole('button', { name: 'ارسال دوباره به ناموفق‌ها (2)' }));
    // Roadmap C2: a re-queue is asked first, saying what is and is never re-sent.
    fireEvent.click(await screen.findByRole('button', { name: 'بله، دوباره در صف بگذار' }));
    await waitFor(() => expect(asked()).toBeGreaterThan(before));
  });

  it('drops the count and its estimate when the draft is saved again', async () => {
    const draft = { broadcast: broadcast() };
    stubApi([
      OPTIONS,
      { url: `/broadcasts/${ID}`, body: draft },
      { url: `/broadcasts/${ID}/preview`, body: previewBody(3) },
      { url: `/broadcasts/${ID}/test`, body: { outcome: 'SENT' } },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    fireEvent.click(await screen.findByRole('button', { name: 'شمارش دقیق گیرندگان' }));
    expect(await screen.findByText('لغو اشتراک تبلیغاتی (تخمین)')).toBeInTheDocument();
    // The draft is saved elsewhere as a service announcement: a new version is read back.
    draft.broadcast = broadcast({ purpose: 'SERVICE_ANNOUNCEMENT', version: 4 });
    fireEvent.click(screen.getByRole('button', { name: 'ارسال آزمایشی به تلگرام من' }));
    await waitFor(() => expect(screen.queryByText('لغو اشتراک تبلیغاتی (تخمین)')).toBeNull());
    expect(screen.queryByRole('button', { name: 'ارسال همین حالا' })).toBeNull();
  });

  it('says nothing failed when every attempt was delivered', async () => {
    stubApi([
      {
        url: `/broadcasts/${ID}`,
        body: {
          broadcast: broadcast({
            state: 'COMPLETED',
            recipientCount: 2,
            progressPercent: 100,
            counts: { ...ZERO, total: 2, sent: 2 },
          }),
        },
      },
      { url: `/broadcasts/${ID}/recipients`, body: { recipients: [], nextCursor: null } },
      { url: `/broadcasts/${ID}/failures`, body: { reasons: [] } },
    ]);
    renderPage(<BroadcastDetailPage id={ID} denied={false} maySend />);
    expect(await screen.findByText('نتیجه: همه رسید')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('همهٔ تلاش‌ها رسیده‌اند.')).toBeInTheDocument());
  });
});
