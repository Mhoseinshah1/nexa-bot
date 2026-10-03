import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { reportFinancialResponseSchema } from '@nexa/contracts';
import { ReportsPage, financialGranularityOf } from '../../apps/web/src/pages/business';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Phase E2 — the financial statement tab (`docs/financial-reports.md`). The fixture is parsed
 * by the contract's own schema, so it cannot drift from what the server sends.
 */

const PERIOD = {
  range: 'THIS_MONTH',
  timezone: 'Asia/Tehran',
  calendar: 'jalali',
  granularity: 'WEEK',
  current: {
    start: '2026-09-22T20:30:00.000Z',
    end: '2026-10-22T20:30:00.000Z',
    effectiveEnd: '2026-10-03T08:30:00.000Z',
    startLocal: '1405/07/01',
    endLocalInclusive: '1405/07/30',
  },
  previous: {
    start: '2026-08-22T20:30:00.000Z',
    end: '2026-09-22T20:30:00.000Z',
    effectiveEnd: '2026-09-02T08:30:00.000Z',
    startLocal: '1405/06/01',
    endLocalInclusive: '1405/06/31',
  },
  lengthsDiffer: true,
  generatedAt: '2026-10-03T08:30:00.000Z',
};

const lines = (currency: string, over: Record<string, string | number> = {}) => ({
  currency,
  salesCount: 2,
  grossSales: '480000',
  discounts: '50000',
  sales: '430000',
  refundCount: 1,
  refunds: '200000',
  refundsToWallet: '200000',
  refundsPaidOut: '0',
  netSales: '230000',
  externalPayments: 1,
  principalReceived: '500000',
  customerFees: '4000',
  customerPaid: '504000',
  receiptCredits: '70000',
  walletTopups: '500000',
  walletSpending: '300000',
  cashbackNet: '12500',
  commissionNet: '6250',
  gifts: '0',
  ...over,
});

const REPORT = reportFinancialResponseSchema.parse({
  period: PERIOD,
  granularity: 'WEEK',
  buckets: [
    {
      index: 0,
      start: '2026-09-22T20:30:00.000Z',
      end: '2026-09-29T20:30:00.000Z',
      label: '1405/07/01–1405/07/07',
      lines: [lines('IRT')],
    },
    {
      index: 1,
      start: '2026-09-29T20:30:00.000Z',
      end: '2026-10-06T20:30:00.000Z',
      label: '1405/07/08–1405/07/14',
      lines: [
        lines('USD', { sales: '1234', grossSales: '1234', discounts: '0', netSales: '1234' }),
      ],
    },
    {
      index: 2,
      start: '2026-10-06T20:30:00.000Z',
      end: '2026-10-13T20:30:00.000Z',
      label: '1405/07/15–1405/07/21',
      lines: null,
    },
  ],
  totals: [
    lines('IRT'),
    lines('USD', { sales: '1234', grossSales: '1234', discounts: '0', netSales: '1234' }),
  ],
  salesByChannel: [
    { method: 'WALLET', provider: null, currency: 'IRT', orders: 1, sales: '300000' },
    { method: null, provider: null, currency: 'IRT', orders: 1, sales: '0' },
  ],
  cashByRoute: [
    {
      method: 'GATEWAY',
      provider: 'TONPAYS',
      kind: 'ORDER',
      currency: 'IRT',
      payments: 1,
      principal: '200000',
      customerFees: '4000',
      customerPaid: '204000',
    },
  ],
  byProduct: [
    {
      productId: '019360ab-cdef-7012-8345-6789abcdef01',
      title: 'Plan Gold',
      currency: 'IRT',
      orders: 2,
      sales: '430000',
      refunds: '200000',
    },
  ],
  byProductTruncated: false,
  resellerSales: [{ currency: 'IRT', orders: 1, sales: '90000' }],
  wallet: [
    {
      currency: 'IRT',
      opening: '1000',
      closing: '201000',
      movements: [
        { group: 'TOPUP', amount: '500000' },
        { group: 'SPENDING', amount: '-300000' },
      ],
    },
  ],
  providerFeeRecorded: false,
  profitSupported: false,
});

const route = (query: string) => ({ path: '/reports', query: new URLSearchParams(query) });

describe('the financial statement tab', () => {
  it('shows the definitions, the three sections per currency and the two honest absences', async () => {
    stubApi([{ url: '/reports/financial', body: REPORT }]);
    renderPage(<ReportsPage route={route('tab=finance&range=THIS_MONTH')} denied={false} />);
    expect(await screen.findByText(t('web.finance_def_topup'))).toBeTruthy();
    expect(screen.getByText(t('web.finance_def_sales'))).toBeTruthy();
    expect((await screen.findByTestId('finance-provider-fee')).textContent).toBe(
      t('web.finance_provider_fee_not_recorded'),
    );
    expect(screen.getByTestId('finance-no-profit').textContent).toBe(t('web.finance_no_profit'));
    // Currencies are columns side by side, never one summed column.
    const sales = screen.getByRole('table', { name: t('web.finance_section_sales') });
    expect(within(sales).getByRole('columnheader', { name: 'IRT' })).toBeTruthy();
    expect(within(sales).getByRole('columnheader', { name: 'USD' })).toBeTruthy();
    // A bucket that has not begun draws no row.
    const buckets = screen.getByRole('table', { name: t('web.finance_buckets_title') });
    expect(within(buckets).queryByText('1405/07/15–1405/07/21')).toBeNull();
    expect(within(buckets).getByText('1405/07/01–1405/07/07')).toBeTruthy();
    // The liability reconciles on the page: opening, each movement, closing.
    const wallet = screen.getByRole('table', { name: `${t('web.finance_wallet_title')} IRT` });
    expect(within(wallet).getByText(t('web.finance_opening'))).toBeTruthy();
    expect(within(wallet).getByText(t('web.finance_closing'))).toBeTruthy();
    expect(screen.getByText(t('web.finance_no_payment'))).toBeTruthy();
  });

  it('asks for the granularity in the URL, and exports the same buckets the page shows', async () => {
    const api = stubApi([{ url: '/reports/financial', body: REPORT }]);
    renderPage(
      <ReportsPage
        route={route('tab=finance&range=THIS_MONTH&granularity=WEEK')}
        denied={false}
        mayExport
      />,
    );
    await screen.findByText(t('web.finance_def_topup'));
    const call = api.calls.find((c) => c.url.includes('/reports/financial?'));
    expect(new URL(call!.url, 'http://x').searchParams.get('granularity')).toBe('WEEK');
    const csv = screen.getByRole('link', { name: 'خروجی CSV' });
    const params = new URL(csv.getAttribute('href')!, 'http://x').searchParams;
    expect(params.get('report')).toBe('FINANCIAL');
    expect(params.get('granularity')).toBe('WEEK');
    expect(params.get('range')).toBe('THIS_MONTH');
  });

  it('draws no export without reports.export', async () => {
    stubApi([{ url: '/reports/financial', body: REPORT }]);
    renderPage(<ReportsPage route={route('tab=finance&range=THIS_MONTH')} denied={false} />);
    await screen.findByText(t('web.finance_def_topup'));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'خروجی CSV' })).toBeNull());
  });

  it('reads only a known granularity from the URL', () => {
    expect(financialGranularityOf(route('granularity=MONTH'))).toBe('MONTH');
    expect(financialGranularityOf(route('granularity=HOUR'))).toBeUndefined();
    expect(financialGranularityOf(route(''))).toBeUndefined();
  });
});
