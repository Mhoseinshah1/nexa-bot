import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { NAV, navPermitted } from '../../apps/web/src/app';
import {
  BulkOperationDetailPage,
  BulkOperationNewPage,
} from '../../apps/web/src/pages/bulk-operations';
import { renderPage, stubApi } from './harness';

/**
 * «عملیات گروهی» in the Web Admin (round N, B2): a mass wallet credit shows the exact count
 * and total liability before anything moves, and cannot be executed without a reason, the
 * typed count and the confirmation; a grant awaiting reconciliation says so.
 */

const ID = '019290ab-cdef-7012-8345-6789abcdef01';
const OPTIONS = {
  url: '/audience/options',
  body: { currency: 'IRT', resellerTiers: [], products: [], panels: [] },
};

function operation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    kind: 'SERVICE_TRAFFIC',
    state: 'RUNNING',
    amount: null,
    trafficBytes: String(10n * 1_073_741_824n),
    durationDays: null,
    notify: true,
    note: 'gift',
    audience: { version: 1 },
    audienceHash: 'a'.repeat(64),
    audienceAsOf: '2026-09-20T10:00:00.000Z',
    notBefore: null,
    itemCount: 2,
    fingerprint: 'b'.repeat(32),
    totalLiability: null,
    creditedTotal: null,
    counts: {
      total: 2,
      pending: 0,
      credited: 0,
      planned: 1,
      awaitingReconciliation: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      notified: 1,
    },
    progressPercent: 50,
    createdBy: { id: 'x', username: 'owner' },
    createdAt: '2026-09-20T10:00:00.000Z',
    completedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

describe('mass operations in the Web Admin', () => {
  it('is reached on bulk_operations.view', () => {
    const entry = NAV.find((candidate) => candidate.id === 'bulk-operations');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(navPermitted(entry, ['bulk_operations.view'])).toBe(true);
    expect(navPermitted(entry, ['users.view'])).toBe(false);
  });

  it('shows count and total liability, and executes only with reason, typed count and confirmation', async () => {
    const api = stubApi([
      OPTIONS,
      {
        url: '/bulk-operations/preview',
        body: {
          preview: {
            kind: 'WALLET_CREDIT',
            asOf: '2026-09-20T10:00:00.000Z',
            definition: { version: 1 },
            definitionHash: 'a'.repeat(64),
            count: 3,
            customers: 3,
            fingerprint: 'b'.repeat(32),
            totalLiability: { amountMinor: '150000', currency: 'IRT' },
            trafficBytesPerItem: null,
            durationDaysPerItem: null,
            sample: [],
          },
        },
      },
      { url: '/bulk-operations', body: { operation: operation({ kind: 'WALLET_CREDIT' }) } },
    ]);
    renderPage(<BulkOperationNewPage mayWallet mayGrant={false} />);
    fireEvent.change(await screen.findByLabelText('مبلغ برای هر کاربر'), {
      target: { value: '50000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'شمارش دقیق و محاسبهٔ مبلغ کل' }));
    expect(await screen.findByText('مبلغ کل تعهد')).toBeInTheDocument();
    expect(screen.getByText(/150|۱۵۰/u)).toBeInTheDocument();

    const execute = screen.getByRole('button', { name: 'تأیید و اجرا' });
    expect(execute).toBeDisabled();
    fireEvent.change(screen.getByLabelText('دلیل (الزامی)'), { target: { value: 'Nowruz' } });
    fireEvent.change(screen.getByLabelText(/تعداد موارد را دقیقاً وارد کنید/u), {
      target: { value: '3' },
    });
    expect(execute).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/این عملیات را تأیید می‌کنم/u));
    expect(execute).not.toBeDisabled();
    fireEvent.click(execute);
    await waitFor(() =>
      expect(
        api.calls.some((call) => call.method === 'POST' && call.url.endsWith('/bulk-operations')),
      ).toBe(true),
    );
    const create = api.calls.find(
      (call) => call.method === 'POST' && call.url.endsWith('/bulk-operations'),
    );
    expect(create?.body).toMatchObject({
      grant: { kind: 'WALLET_CREDIT', amountMinor: '50000', currency: 'IRT' },
      expectedCount: 3,
      expectedTotalMinor: '150000',
      typedCount: 3,
      note: 'Nowruz',
      confirmed: true,
    });
  });

  it('says a grant is awaiting reconciliation rather than calling it done', async () => {
    stubApi([
      { url: `/bulk-operations/${ID}`, body: { operation: operation() } },
      {
        url: `/bulk-operations/${ID}/items`,
        body: {
          items: [
            {
              id: '019290ab-cdef-7012-8345-6789abcdef02',
              customerId: '019290ab-cdef-7012-8345-6789abcdef03',
              firstName: 'Sara',
              username: null,
              serviceId: '019290ab-cdef-7012-8345-6789abcdef04',
              serviceLabel: 'nxabc',
              state: 'PLANNED',
              skipReason: null,
              operationState: 'UNKNOWN',
              failureKind: null,
              notified: false,
              processedAt: '2026-09-20T10:00:00.000Z',
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    renderPage(<BulkOperationDetailPage id={ID} denied={false} mayWallet={false} mayGrant />);
    expect(await screen.findByText('nxabc')).toBeInTheDocument();
    expect(screen.getAllByText('در انتظار بررسی نتیجه روی پنل').length).toBeGreaterThan(1);
    expect(screen.getByRole('button', { name: 'لغو موارد باقی‌مانده' })).toBeInTheDocument();
  });
});
