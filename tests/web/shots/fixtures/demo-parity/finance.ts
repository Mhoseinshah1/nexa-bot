import {
  paymentListResponseSchema,
  paymentSituationOf,
  type PaymentSituationFacts,
} from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../../fixture.ts';

/*
 * DEMO PARITY — the finance family (payments, payment methods, discounts, referrals,
 * campaigns, resellers, reseller plans and tiers, reports), fed the approved demo's own
 * sample rows (`approved-demo.html#/payments` and the rest) so a side-by-side compares like
 * with like, and so every state a DIFFS bullet names is on screen: the payment situations
 * («رسید در انتظار بررسی», «در انتظار پرداخت مشتری», a customer's claim without a receipt),
 * a route with an IPN secret and a passed check, a suspended reseller on a tier, …
 *
 * Only fields the API has. Every body is parsed by its response schema in
 * `tests/web/shots-fixtures.test.tsx`.
 */

type Json = Record<string, unknown>;

/** A stable uuid-shaped id: `prefix` (8 hex) and the row's index. */
function uid(prefix: string, index: number): string {
  return `${prefix}-${(0xa1b2 + index).toString(16)}-7012-8345-${(0x6789abcdef01 + index).toString(16).padStart(12, '0')}`;
}

// --- payments (`#/payments`) --------------------------------------------------

const PAY_CUSTOMERS = [
  ['676309375', 'farhad_y'],
  ['606935783', 'ali_rezaei'],
  ['982530490', 'zahra_j'],
  ['584332434', 'maryam_s'],
  ['319675910', 'hossein_m'],
  ['959498386', 'sara_m'],
  ['403962768', 'fatemeh_k'],
  ['767614693', 'amir_h'],
  ['872170802', 'reza_n'],
  ['495954583', 'negar_a'],
] as const;

interface DemoPayment {
  readonly state: 'CONFIRMED' | 'PENDING';
  readonly method: 'WALLET' | 'MANUAL_TRANSFER' | 'GATEWAY';
  readonly amount: string;
  readonly receipt: boolean;
  readonly signalled: boolean;
}

/** The demo's first page, in its order: a wallet payment, then the transfers it waits on. */
const DEMO_PAYMENTS: readonly DemoPayment[] = [
  { state: 'CONFIRMED', method: 'WALLET', amount: '450000', receipt: false, signalled: false },
  {
    state: 'PENDING',
    method: 'MANUAL_TRANSFER',
    amount: '2000000',
    receipt: false,
    signalled: false,
  },
  { state: 'PENDING', method: 'MANUAL_TRANSFER', amount: '450000', receipt: true, signalled: true },
  {
    state: 'PENDING',
    method: 'MANUAL_TRANSFER',
    amount: '250000',
    receipt: false,
    signalled: true,
  },
  { state: 'PENDING', method: 'GATEWAY', amount: '850000', receipt: false, signalled: false },
  {
    state: 'PENDING',
    method: 'MANUAL_TRANSFER',
    amount: '1500000',
    receipt: true,
    signalled: true,
  },
  { state: 'PENDING', method: 'MANUAL_TRANSFER', amount: '310000', receipt: true, signalled: true },
  { state: 'PENDING', method: 'MANUAL_TRANSFER', amount: '120000', receipt: true, signalled: true },
  { state: 'PENDING', method: 'MANUAL_TRANSFER', amount: '100000', receipt: true, signalled: true },
  { state: 'PENDING', method: 'MANUAL_TRANSFER', amount: '210000', receipt: true, signalled: true },
];

function situationOf(row: DemoPayment, topup: boolean): Json {
  const facts: PaymentSituationFacts = {
    state: row.state,
    method: row.method,
    topup,
    customerSignalled: row.signalled,
    receiptFiled: row.receipt,
    providerReviewOpened: false,
    resolvedByAdmin: false,
    receiptDisposition: null,
    invoiceCreation: row.method === 'GATEWAY' ? 'CREATED' : null,
    queues: [],
    refundOpen: false,
    refundCompleted: false,
    refundRemaining: row.state === 'CONFIRMED',
    refundRefusal: null,
  };
  const guide = paymentSituationOf(facts);
  return { ...guide, actions: [...guide.actions] };
}

/** The demo's payment ids, as its first column shows them (the first eight characters). */
const PAYMENT_IDS = [
  '0009f4a8',
  '49888b85',
  '22813371',
  '5ac7a14c',
  'c44cb575',
  '31fb1eb3',
  'fc328a48',
  'f04109ba',
  '747b516c',
  'dddc5e0b',
];

const REFERENCES = [
  '39084112bb375b94',
  '21ec0be44de75e1d',
  '3e1b91db9231174d',
  '17675e4052554c04',
  'ed1da5bec38bbf5f',
  'bf84972fcfca45af',
  'edde3d272f94846f',
  'eec295e0e1ae36c5',
  '7926e8609bf5ea65',
  '2614f54b501cb250',
];

export const DEMO_PAYMENT_ROWS: readonly Json[] = DEMO_PAYMENTS.map((row, index) => {
  const [telegram, username] = PAY_CUSTOMERS[index % PAY_CUSTOMERS.length] ?? ['0', 'x'];
  const channel =
    row.method === 'WALLET' ? 'wallet' : row.method === 'GATEWAY' ? 'tonpays' : 'manual';
  const topup = index === 3;
  return {
    id: uid(PAYMENT_IDS[index] ?? '0009f4a8', index),
    customerId: uid('019210ab', index),
    orderId: topup ? null : uid('019230ab', index),
    state: row.state,
    method: row.method,
    amount: row.amount,
    currency: 'IRT',
    reference: `${REFERENCES[index] ?? ''}:${channel}`,
    evidenceKind: row.state === 'CONFIRMED' ? 'WALLET_DEBIT' : null,
    confirmedAt: row.state === 'CONFIRMED' ? ago(60 * 2) : null,
    confirmedByAdminId: null,
    resolvedAt: null,
    resolvedByAdminId: null,
    customerSignalledAt: row.signalled ? ago(30 + index * 25) : null,
    expiresAt: row.state === 'PENDING' ? ago(-60 * 6) : null,
    createdAt: ago(40 + index * 25),
    updatedAt: ago(30 + index * 25),
    gatewayProvider:
      row.method === 'GATEWAY'
        ? 'TONPAYS'
        : row.method === 'MANUAL_TRANSFER'
          ? 'MANUAL_TRANSFER'
          : null,
    externalReference: row.method === 'GATEWAY' ? 'tp_88124' : null,
    customerTelegramUserId: telegram,
    customerUsername: username,
    receiptDisposition: null,
    gatewaySignal:
      row.method === 'GATEWAY'
        ? {
            creationState: 'CREATED',
            creationErrorCode: null,
            providerStatus: 'pending',
            providerPaid: false,
            lastInquiryAt: ago(20),
            lastInquiryErrorCode: null,
            outcome: null,
            lateCompletionObservedAt: null,
            reconcileInquiryRequestedAt: null,
          }
        : null,
    situation: situationOf(row, topup),
  };
});

const PAYMENTS: readonly ShotFixture[] = [
  fixture('/payments', paymentListResponseSchema, {
    payments: DEMO_PAYMENT_ROWS,
    nextCursor: 'pay-2',
  }),
];

export const DEMO_FINANCE: readonly ShotFixture[] = [...PAYMENTS];
