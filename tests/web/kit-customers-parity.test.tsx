import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SERVICE_OPERATOR_ACTIONS } from '@nexa/contracts';
import { OrderDetailPage, OrdersPage } from '../../apps/web/src/pages/orders';
import { ServiceDetailPage, ServicesPage } from '../../apps/web/src/pages/services';
import { UserDetailPage, UsersPage } from '../../apps/web/src/pages/users';
import { customerTabs } from '../../apps/web/src/pages/customer-360';
import { ActionPanel } from '../../apps/web/src/ui/action-panel';
import { PageMoreMenu } from '../../apps/web/src/ui/page-more-menu';
import { ListExportBar, toCsv, useRowSelection } from '../../apps/web/src/ui/row-export';
import { t } from '../../apps/web/src/i18n/web.fa';
import { customer, order, renderPage, stubApi } from './harness';

/**
 * Demo parity, PR-1 (the shared kit + customers, orders, services): every element the owner's
 * diff report listed as «only in the demo» is asserted here, and every «only in the app» one is
 * asserted absent. Removing a restored element — a box, a column, a tab, the banner, the CSV —
 * fails a case below (see the PR's mutation checks).
 */

const SERVICE_ID = '019250ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';
const PANEL_ID = '019220ab-cdef-7012-8345-6789abcdef01';
const PRODUCT_ID = '019215ab-cdef-7012-8345-6789abcdef01';

const service = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: SERVICE_ID,
  customerId: CUSTOMER_ID,
  orderId: ORDER_ID,
  panelId: PANEL_ID,
  productId: PRODUCT_ID,
  state: 'ACTIVE',
  providerUsername: 'nx-7f3a91',
  providerUserId: '4821',
  hasSubscription: true,
  isTrial: false,
  expiresAt: '2026-12-01T00:00:00.000Z',
  trafficLimitBytes: '53687091200',
  trafficUsedBytes: '1073741824',
  deviceLimit: null,
  usageSyncedAt: '2026-09-15T08:00:00.000Z',
  deliveryState: 'DELIVERED',
  deliveredAt: '2026-09-10T12:35:00.000Z',
  provisionedAt: '2026-09-10T12:34:00.000Z',
  terminatedAt: null,
  createdAt: '2026-09-10T12:30:00.000Z',
  updatedAt: '2026-09-10T12:35:00.000Z',
  ...overrides,
});

const actions = (available: readonly string[]) =>
  SERVICE_OPERATOR_ACTIONS.map((action) =>
    available.includes(action)
      ? { action, available: true, blocker: null }
      : { action, available: false, blocker: 'STATE' },
  );

const detailRoutes = (available: readonly string[] = ['SUSPEND', 'TERMINATE']) => [
  {
    url: `/services/${SERVICE_ID}/operations`,
    body: { operations: [], limit: 50, hasMore: false },
  },
  {
    url: `/services/${SERVICE_ID}/refund-requests`,
    body: { requests: [], nextCursor: null },
  },
  {
    url: `/services/${SERVICE_ID}`,
    body: {
      service: {
        deliveryAttempts: 1,
        deliveryNextAttemptAt: null,
        actions: actions(available),
        ...service(),
      },
    },
  },
];

const headers = () => screen.getAllByRole('columnheader').map((th) => th.textContent?.trim());

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the shared action panel (A1)', () => {
  it('draws titled boxes in one titled panel, with a separate red «عملیات حساس» box', () => {
    render(
      <ActionPanel
        title="عملیات روی این نمونه"
        groups={[
          { key: 'a', title: 'گروه اول', actions: [<button key="1">یک</button>] },
          { key: 'b', title: 'گروه دوم', actions: [<button key="2">دو</button>] },
          { key: 'empty', title: 'گروه خالی', actions: [null, false] },
        ]}
        sensitive={[<button key="3">حساس</button>]}
      />,
    );
    const panel = screen.getByRole('region', { name: 'عملیات روی این نمونه' });
    expect(within(panel).getByRole('group', { name: 'گروه اول' })).not.toHaveClass('danger');
    expect(within(panel).getByRole('group', { name: 'گروه دوم' })).toBeInTheDocument();
    expect(within(panel).queryByRole('group', { name: 'گروه خالی' })).toBeNull();
    const red = within(panel).getByRole('group', { name: t('web.action_panel_sensitive') });
    expect(red).toHaveClass('danger');
    expect(within(red).getByRole('button', { name: 'حساس' })).toBeInTheDocument();
  });
});

describe('the page-head «بیشتر» menu (A5)', () => {
  it('opens a menu of the page’s own items, and draws nothing without any', () => {
    const picked = vi.fn();
    const { container, rerender } = render(
      <PageMoreMenu items={[{ key: 'x', label: 'خروجی کامل', onSelect: picked }]} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'بیشتر' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'خروجی کامل' }));
    expect(picked).toHaveBeenCalledTimes(1);
    rerender(<PageMoreMenu items={[]} />);
    expect(container.textContent).toBe('');
  });
});

describe('the CSV export row (A5)', () => {
  type Row = { id: string; name: string };
  const rows: Row[] = [
    { id: '1', name: 'علی' },
    { id: '2', name: 'مریم' },
  ];

  function Harness({ allowed = true }: { allowed?: boolean }) {
    const selection = useRowSelection(rows, (row) => row.id);
    return (
      <>
        {rows.map((row) => (
          <input
            key={row.id}
            type="checkbox"
            aria-label={`tick ${row.name}`}
            checked={selection.selected.has(row.id)}
            onChange={() => selection.toggle(row.id)}
          />
        ))}
        <ListExportBar
          selection={selection}
          columns={[{ header: 'نام', value: (row) => row.name }]}
          filename="demo"
          allowed={allowed}
        />
      </>
    );
  }

  /** What the click downloads: the Blob's text, read back. */
  async function exported(): Promise<{ bytes: Uint8Array; text: string }> {
    let blob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
      blob = value as Blob;
      return 'blob:x';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: t('web.export_csv') }));
    if (blob === undefined) throw new Error('nothing was downloaded');
    const bytes = await new Promise<Uint8Array>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
      reader.readAsArrayBuffer(blob as Blob);
    });
    return { bytes, text: new TextDecoder().decode(bytes) };
  }

  it('exports the loaded rows when none is ticked: a Persian header row, a BOM, CRLF', async () => {
    render(<Harness />);
    const { bytes, text } = await exported();
    // The UTF-8 byte-order mark, so Excel reads the Persian.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(text).toBe('نام\r\nعلی\r\nمریم\r\n');
  });

  it('exports only the ticked rows once some are ticked', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'tick مریم' }));
    expect(screen.getByText('انتخاب‌شده: 1')).toBeInTheDocument();
    const { text } = await exported();
    expect(text).toBe('نام\r\nمریم\r\n');
    fireEvent.click(screen.getByRole('button', { name: t('web.kit_selection_clear') }));
    expect(screen.queryByRole('button', { name: t('web.kit_selection_clear') })).toBeNull();
  });

  it('draws nothing for a viewer who may not read the list', () => {
    const { container } = render(<Harness allowed={false} />);
    expect(container.textContent).toBe('');
    expect(toCsv(rows, [{ header: 'نام', value: (row) => row.name }]).startsWith('﻿')).toBe(true);
  });
});

describe('/users (A2, A3, A5)', () => {
  const route = { path: '/users', query: new URLSearchParams() };

  it('splits «نام کاربری» and «نام», draws «خروجی CSV» and no status chip row', async () => {
    stubApi([
      {
        url: '/users',
        body: {
          customers: [customer({ firstName: 'علی', lastName: 'رضایی', username: 'ali_r' })],
          nextCursor: null,
        },
      },
    ]);
    renderPage(<UsersPage route={route} maySearch denied={false} />);
    await screen.findByRole('link', { name: 'علی رضایی' });
    const names = headers();
    expect(names).toContain('نام کاربری');
    expect(names).toContain('نام');
    expect(names).not.toContain('کاربر');
    expect(screen.getByRole('button', { name: 'خروجی CSV' })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'انتخاب همهٔ ردیف‌های این صفحه' })).toBeTruthy();
    // The username has its own cell and is not a second link to the same row.
    expect(screen.getByText('@ali_r')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '@ali_r' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'فیلتر وضعیت' })).toBeNull();
  });
});

describe('/orders (A2, A3, A5, §B)', () => {
  const route = { path: '/orders', query: new URLSearchParams() };

  it('draws «سرویس», «کد», «ثبت‌شده در» and «اعتبار تا» as separate columns, with «خروجی CSV»', async () => {
    stubApi([{ url: '/orders', body: { orders: [order()], nextCursor: null } }]);
    renderPage(<OrdersPage route={route} denied={false} />);
    await screen.findByText(String(order().lineTitle));
    const names = headers();
    for (const name of ['سرویس', 'کد', 'ثبت‌شده در', 'اعتبار تا']) {
      expect(names, name).toContain(name);
    }
    expect(names).not.toContain('سفارش / کد');
    expect(names).not.toContain('ثبت / مهلت پرداخت');
    expect(screen.getByRole('button', { name: 'خروجی CSV' })).toBeEnabled();
    // No always-visible status chip row (the filter lives in the «فیلترها» panel).
    expect(screen.queryByRole('button', { name: t('web.order_state_refunded') })).toBeNull();
  });

  it('keeps the order title free of the purpose badge «خرید سرویس جدید»', async () => {
    stubApi([{ url: `/orders/${ORDER_ID}`, body: { order: order({ purpose: 'NEW_SERVICE' }) } }]);
    renderPage(
      <OrderDetailPage
        id={ORDER_ID}
        denied={false}
        mayViewPayments={false}
        mayViewServices={false}
      />,
    );
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent ?? '').not.toContain('خرید سرویس جدید');
  });
});

describe('/services (A2, A3)', () => {
  const route = { path: '/services', query: new URLSearchParams() };

  it('draws the demo’s nine columns, split, and real tabs «فعال / پایان‌یافته / همه»', async () => {
    stubApi([{ url: '/services', body: { services: [service()], nextCursor: null } }]);
    renderPage(<ServicesPage route={route} denied={false} />);
    await screen.findAllByText('nx-7f3a91');
    const names = headers();
    for (const name of [
      'نام کاربری روی پنل',
      'کد',
      'تحویل به مشتری',
      'پنل',
      'لوکیشن',
      'انقضا',
      'تاریخ خرید',
    ]) {
      expect(names, name).toContain(name);
    }
    for (const merged of ['سرویس / کد', 'پنل / لوکیشن', 'وضعیت / تحویل', 'انقضا / شروع']) {
      expect(names).not.toContain(merged);
    }
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['فعال', 'پایان‌یافته', 'همه']);
  });
});

describe('/services/:id (A1, §B)', () => {
  it('groups the actions into the four demo boxes and a red sensitive box', async () => {
    stubApi(detailRoutes());
    renderPage(<ServiceDetailPage id={SERVICE_ID} denied={false} mayEdit mayTerminate mayGrant />);
    await screen.findAllByText('nx-7f3a91');
    const panel = screen.getByRole('region', { name: 'عملیات روی این سرویس' });
    for (const box of ['پنل و همگام‌سازی', 'لینک اشتراک', 'وضعیت سرویس', 'هدیه و تغییر']) {
      expect(within(panel).getByRole('group', { name: box }), box).toBeInTheDocument();
    }
    const red = within(panel).getByRole('group', { name: 'عملیات حساس' });
    expect(red).toHaveClass('danger');
    expect(within(red).getByRole('button', { name: 'حذف سرویس…' })).toBeEnabled();
    expect(screen.queryByRole('toolbar', { name: 'عملیات روی این سرویس' })).toBeNull();
  });

  it('draws the KPI cards before the refund-request table', async () => {
    stubApi(detailRoutes());
    const { container } = renderPage(
      <ServiceDetailPage
        id={SERVICE_ID}
        denied={false}
        mayEdit
        mayTerminate
        mayViewRefundRequests
      />,
    );
    await screen.findAllByText('nx-7f3a91');
    const refunds = await screen.findByText(t('web.service_refunds'));
    const kpi = container.querySelector('.kpi-row');
    expect(kpi).not.toBeNull();
    expect(
      (kpi as HTMLElement).compareDocumentPosition(refunds) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('/users/:id (A1, §B)', () => {
  it('names the demo’s tabs', () => {
    expect(customerTabs(true).map((tab) => tab.label)).toEqual([
      'نمای کلی',
      'سرویس‌ها و سفارش‌ها',
      'مالی',
      'محدودیت‌ها و کنترل‌ها',
      'تاریخچهٔ مدیریتی',
      'پشتیبانی',
      'معرف و نماینده',
      'پیام‌ها',
      'یادداشت‌ها و برچسب‌ها',
    ]);
  });

  it('draws the blocked card, the three boxes and the red box', async () => {
    const id = CUSTOMER_ID;
    stubApi([
      {
        url: `/users/${id}`,
        body: {
          customer: customer({
            id,
            status: 'BLOCKED',
            blockedAt: '2026-09-11T09:00:00.000Z',
            blockedReason: 'spam',
          }),
        },
      },
    ]);
    renderPage(
      <UserDetailPage
        id={id}
        denied={false}
        mayBlock
        mayEditTrial={false}
        mayViewWallet={false}
        mayCredit={false}
        mayDebit={false}
        mayViewOrders
        mayViewServices={false}
        mayViewReferrals={false}
        mayViewReseller={false}
        mayEditReseller={false}
        mayTransfer
        mayEditServices
      />,
    );
    const panel = await screen.findByRole('region', { name: 'عملیات روی این مشتری' });
    expect(within(panel).getByRole('group', { name: 'سفارش‌ها' })).toBeInTheDocument();
    expect(within(panel).getByRole('group', { name: 'ارتباط و دسترسی' })).toBeInTheDocument();
    expect(within(panel).getByRole('group', { name: 'عملیات حساس' })).toHaveClass('danger');
    expect(screen.getByRole('alert').textContent).toContain('این مشتری مسدود است');
  });
});
