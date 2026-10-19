import {
  customerListResponseSchema,
  customerResponseSchema,
  customerWorkspaceResponseSchema,
} from '@nexa/contracts';
import { SHOT_NOW, ago, fixture, type ShotFixture } from '../../fixture.ts';

/*
 * DEMO PARITY — the customers and support family (users, Customer 360, tickets, support,
 * business chats, the notification center and the support AI pages) fed the approved demo's own
 * sample rows (`approved-demo.html#/users`, `#/users/584332434`, `#/tickets`, …), so a
 * side-by-side compares like with like, and every state a DIFFS bullet names is on screen:
 * a blocked customer, an empty attention queue, a chat with a ticket, a rejected provider key,
 * a conflicting knowledge proposal and a retired one.
 *
 * Only fields the API has. Every body is parsed by its response schema in
 * `tests/web/shots-fixtures.test.tsx`.
 */

type Json = Record<string, unknown>;

function uid(prefix: string, index: number): string {
  return `${prefix}-cdef-7012-8345-${String(6789 + index).padStart(4, '0')}abcdef01`;
}

const DAY = 60 * 24;

/** The demo's ten customers (`#/users`), in its order. */
const DEMO_CUSTOMERS: readonly [string, string, string, string, boolean][] = [
  ['584332434', 'maryam_s', 'مریم', 'صادقی', true],
  ['484648889', 'kian_f', 'کیان', 'فرهادی', false],
  ['791344225', 'omid_sh', 'امید', 'شاکری', false],
  ['588644405', 'reyhane_f', 'ریحانه', 'فتحی', false],
  ['403205025', 'roya_mn', 'رویا', 'منصوری', false],
  ['999546491', 'pooya_sh', 'پویا', 'شریفی', false],
  ['403735776', 'ghazal_t', 'غزل', 'توکلی', false],
  ['291406883', 'neda_r', 'ندا', 'رستمی', false],
  ['652949939', 'aida_s', 'آیدا', 'سلیمانی', false],
  ['673267723', 'elham_q', 'الهام', 'قاسمی', false],
];

export const DEMO_CUSTOMER_ROWS: readonly Json[] = DEMO_CUSTOMERS.map(
  ([telegram, username, first, last, blocked], index) => ({
    id: uid('019d10ab', index),
    telegramUserId: telegram,
    username,
    firstName: first,
    lastName: last,
    languageCode: 'fa',
    status: blocked ? 'BLOCKED' : 'ACTIVE',
    firstSeenAt: ago(DAY * (128 - index * 2) + 60 * index),
    lastSeenAt: ago(DAY * (index % 4) + 60 * (index * 3 + 1)),
    blockedAt: blocked ? ago(DAY * 2 + 300) : null,
    blockedReason: blocked ? 'ارسال رسید جعلی — ۲ بار' : null,
    blockedReasonShown: blocked,
    marketingOptOutAt: null,
  }),
);

/** Customer 360 of the demo's first customer: BLOCKED, nothing waiting for an operator. */
const WORKSPACE = {
  workspace: {
    generatedAt: SHOT_NOW,
    tickets: { awaitingSupport: 0, open: 0 },
    businessHandoffs: 0,
    businessHandoffConversationId: null,
    payments: {
      unknown: 0,
      latest: (
        [
          ['NX-874854', 'PENDING', '780000', 60 * 2],
          ['NX-356631', 'CONFIRMED', '780000', DAY + 60 * 6],
          ['NX-651350', 'CONFIRMED', '420000', DAY * 2 + 60 * 3],
          ['NX-401787', 'CONFIRMED', '420000', DAY * 5],
          ['NX-290579', 'CONFIRMED', '500000', DAY * 8],
        ] as const
      ).map(([reference, state, amount, minutes], index) => ({
        id: uid('019d20ab', index),
        reference,
        method: 'MANUAL_TRANSFER',
        state,
        amount,
        currency: 'IRT',
        createdAt: ago(minutes),
      })),
    },
    services: { unreconciled: 0 },
    orders: {
      latest: (
        [
          ['نمایندگی ۵۰۰ گیگ', 'AWAITING_PAYMENT', '780000', 60 * 2],
          ['یک‌ماهه ۱۰۰ گیگ — فنلاند', 'PAID', '378000', DAY * 2 + 60 * 3],
          ['یک‌ماهه ۱۰۰ گیگ — فنلاند', 'PAID', '420000', DAY * 5],
        ] as const
      ).map(([lineTitle, state, totalAmount, minutes], index) => ({
        id: uid('019d30ab', index),
        lineTitle,
        purpose: 'NEW_SERVICE',
        state,
        totalAmount,
        currency: 'IRT',
        createdAt: ago(minutes),
      })),
    },
  },
};

export const DEMO_CUSTOMERS_FAMILY: readonly ShotFixture[] = [
  fixture('/users', customerListResponseSchema, {
    customers: DEMO_CUSTOMER_ROWS,
    nextCursor: 'cus-2',
  }),
  fixture('/users/:id', customerResponseSchema, { customer: DEMO_CUSTOMER_ROWS[0] }),
  fixture('/users/:id/workspace', customerWorkspaceResponseSchema, WORKSPACE),
];
