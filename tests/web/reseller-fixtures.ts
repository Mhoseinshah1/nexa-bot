import type { Route } from './harness';

/**
 * Wire fixtures of the reseller panel API (`/api/reseller/v1`), shaped as the contract schemas
 * describe them — the real client parses every one, so a fixture that drifts fails the test.
 */
export const irt = (amountMinor: string) => ({ amountMinor, currency: 'IRT' as const });

export const TOKEN = 'a'.repeat(43);
export const NOW = '2026-11-10T10:00:00.000Z';

export function me(overrides: Record<string, unknown> = {}) {
  return {
    customer: { firstName: 'آرین', username: 'arian_store', telegramUserId: '1001' },
    reseller: { tierName: 'طلایی', since: '2026-03-12T00:00:00.000Z' },
    balance: irt('2450000'),
    botUsername: 'nexa_test_bot',
    secondFactor: false,
    session: { id: 'sess-current', expiresAt: '2026-12-10T10:00:00.000Z' },
    ...overrides,
  };
}

export function serviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'svc-1',
    code: 'AR-1043',
    username: 'ar_1043',
    client: null,
    note: 'رضا',
    product: '50 گیگ',
    location: 'آلمان',
    state: 'ACTIVE',
    trafficUsedBytes: '10737418240',
    trafficLimitBytes: '53687091200',
    expiresAt: '2099-01-01T00:00:00.000Z',
    expiring: false,
    isTrial: false,
    ...overrides,
  };
}

export function serviceDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...serviceRow(),
    subscriptionUrl: 'https://sub.example.com/s/ar_1043-7f3a9c',
    qrKinds: ['SINGBOX', 'SUB_LINK'],
    singboxProfileName: 'nexa-ar_1043',
    filesOnly: false,
    filesOffered: false,
    canRotateLink: true,
    actions: ['RENEW', 'ADD_TRAFFIC'],
    working: true,
    ...overrides,
  };
}

export function dashboard(overrides: Record<string, unknown> = {}) {
  return {
    balance: irt('2450000'),
    activeServices: 12,
    monthSales: { count: 38, amount: [irt('12450000')] },
    expiringCount: 1,
    expiring: [serviceRow({ id: 'svc-exp', username: 'ar_9001', expiring: true })],
    tier: { name: 'طلایی', pricingMode: 'PERCENT', discountPercent: 22 },
    recentTransactions: [
      {
        id: 'tx-1',
        direction: 'CREDIT',
        reason: 'TOPUP_GATEWAY',
        amount: irt('500000'),
        at: '2026-11-09T10:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

export function servicesPage(
  items: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    items,
    counts: { ALL: 14, ACTIVE: 12, EXPIRING: 1, EXPIRED: 1, SUSPENDED: 0, OTHER: 0 },
    page: 0,
    pages: 1,
    total: items.length,
    ...overrides,
  };
}

export const prices = {
  groups: [
    {
      categoryId: 'cat-1',
      title: 'ماهانه',
      items: [
        {
          productId: 'p1',
          title: '30 گیگ',
          trafficBytes: '32212254720',
          durationDays: 30,
          listPrice: irt('120000'),
          yourPrice: irt('96000'),
          discountPercent: 20,
        },
      ],
    },
    {
      categoryId: 'cat-2',
      title: 'دوماهه',
      items: [
        {
          productId: 'p2',
          title: '60 گیگ',
          trafficBytes: '64424509440',
          durationDays: 60,
          listPrice: irt('230000'),
          yourPrice: irt('185000'),
          discountPercent: 20,
        },
      ],
    },
  ],
};

/** The routes every signed-in screen needs, for a test that only cares about one screen. */
export function signedIn(extra: readonly Route[] = [], user = me()): Route[] {
  return [{ url: '/api/reseller/v1/me', body: user }, ...extra];
}

export function problem(
  url: string,
  status: number,
  code: string,
  details?: Record<string, unknown>,
): Route {
  return {
    url,
    status,
    body: { error: { kind: 'conflict', code, message: code, correlationId: 'c', details } },
  };
}
