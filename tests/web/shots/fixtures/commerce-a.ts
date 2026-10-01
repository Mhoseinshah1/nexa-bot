import { customerListResponseSchema, customerResponseSchema } from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../fixture.ts';

/*
 * Page family COMMERCE-A: users, trials, services, orders, payments,
 * compensations. The COMMERCE-A agent adds the fixtures its pages need here.
 */

type Json = Record<string, unknown>;

/** One customer, in `customerSummarySchema`'s shape — the web suite's `customer()`. */
export function customer(index: number, over: Json = {}): Json {
  const id = `019210ab-cdef-7012-8345-${String(6789 + index).padStart(4, '0')}abcdef01`;
  return {
    id,
    telegramUserId: String(5551234567 + index * 7919),
    username: `user_${index}`,
    firstName: FIRST[index % FIRST.length],
    lastName: LAST[index % LAST.length],
    languageCode: 'fa',
    status: index % 9 === 4 ? 'BLOCKED' : 'ACTIVE',
    firstSeenAt: ago(60 * 24 * (200 - index * 3)),
    lastSeenAt: ago(60 * (index * 5 + 2)),
    blockedAt: index % 9 === 4 ? ago(60 * 24 * 2) : null,
    blockedReason: index % 9 === 4 ? 'abuse' : null,
    blockedReasonShown: false,
    marketingOptOutAt: null,
    ...over,
  };
}

const FIRST = ['علی', 'مریم', 'سارا', 'حامد', 'مهدی', 'نگار', 'زهرا', 'رضا', 'الهام', 'بهنام'];
const LAST = [
  'رضایی',
  'اکبری',
  'شریفی',
  'کریمی',
  'قاسمی',
  'موسوی',
  'مرادی',
  'نادری',
  'احمدی',
  'زارعی',
];

export const CUSTOMERS: readonly Json[] = Array.from({ length: 14 }, (_, index) => customer(index));

export const COMMERCE_A: readonly ShotFixture[] = [
  fixture('/users', customerListResponseSchema, {
    customers: CUSTOMERS,
    nextCursor: 'cursor-page-2',
  }),
  fixture('/users/:id', customerResponseSchema, { customer: CUSTOMERS[0] }),
];
