import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { CustomerLegacyHistoryCard } from '../../apps/web/src/pages/customer-360-legacy';
import { renderPage, stubApi } from './harness';

/**
 * Mirza `.nxpkg` importer — «سوابق میرزا» on Customer 360: the card is not drawn without
 * `legacy.history.view`, groups a page by record type, filters by type and pages by offset.
 * SYNTHETIC values only.
 */

const ID = '019210ab-cdef-7012-8345-6789abcdef01';

const item = (n: number, recordType: string, summary: Record<string, unknown>) => ({
  id: `019210ab-cdef-7012-8345-6789abcdef1${n}`,
  recordType,
  occurredAt: n === 1 ? '2025-01-01T04:32:17.000Z' : null,
  packageImportId: 'synthetic-import-0001',
  summary,
  payload: { record_type: 'x', customer: { telegram_user_id: null } },
  redacted: ['customer.telegram_user_id'],
  legacyUserId: null,
});

const page = (over: Record<string, unknown> = {}) => ({
  items: [
    item(1, 'payment', { status: 'SUCCEEDED', amountMinor: '35000', currency: 'IRT' }),
    item(2, 'service_operation', { operation: 'RENEWAL' }),
  ],
  matching: 30,
  offset: 0,
  limit: 25,
  byType: [
    { recordType: 'payment', count: 20 },
    { recordType: 'service_operation', count: 10 },
  ],
  piiRedacted: true,
  invoiceArchive: null,
  walletDebts: { debts: 1 },
  ...over,
});

describe('the Mirza history card', () => {
  it('is not drawn, and asks for nothing, without legacy.history.view', () => {
    const api = stubApi([{ url: `/users/${ID}/legacy-history`, body: page() }]);
    const { container } = renderPage(<CustomerLegacyHistoryCard customerId={ID} mayView={false} />);
    expect(container.textContent).toBe('');
    expect(api.calls).toHaveLength(0);
  });

  it('groups by type, says personal data is hidden, filters and pages', async () => {
    const api = stubApi([{ url: `/users/${ID}/legacy-history`, body: page() }]);
    renderPage(<CustomerLegacyHistoryCard customerId={ID} mayView />);
    expect(await screen.findByText('سوابق میرزا')).toBeTruthy();
    await screen.findByRole('heading', { name: 'پرداخت‌ها' });
    expect(screen.getByRole('heading', { name: 'عملیات سرویس' })).toBeTruthy();
    expect(screen.getByText(/اطلاعات شخصی و متن‌های آزاد/)).toBeTruthy();
    expect(screen.getByText('زمان دقیق ثبت نشده')).toBeTruthy();
    expect(screen.getByRole('link', { name: /بدهی‌های کیف پول قدیمی/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^عملیات سرویس/ }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('type=service_operation'))).toBe(true),
    );
    fireEvent.click(await screen.findByRole('button', { name: /^همه/ }));
    await screen.findByRole('heading', { name: 'پرداخت‌ها' });
    fireEvent.click(await screen.findByRole('button', { name: /قدیمی‌تر/ }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('offset=25'))).toBe(true),
    );
  });
});
