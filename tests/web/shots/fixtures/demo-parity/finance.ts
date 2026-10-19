import {
  fxStatusResponseSchema,
  paymentGatewayListResponseSchema,
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

// --- payment methods (`#/payment-gateways`) -----------------------------------

function route(over: Json): Json {
  return {
    status: 'ACTIVE',
    displayName: null,
    instructions: null,
    minAmountMinor: '0',
    maxAmountMinor: '0',
    currency: 'IRT',
    eligibility: {
      activateAfterPayments: 0,
      deactivateAfterPayments: 0,
      activateAfterAccountDays: 0,
    },
    sortOrder: 0,
    topupCashbackPercent: 0,
    customerFeeBasisPoints: 0,
    allowServicePurchase: true,
    allowWalletTopup: true,
    credential: { required: false, setAt: null },
    callbackUrl: null,
    conversion: { rateRequired: false, rateMinor: null },
    createdAt: ago(60 * 24 * 60),
    updatedAt: ago(60 * 24 * 3),
    ...over,
  };
}

/** The demo's six routes: keys set, an IPN secret, a passed check, a missing verify key. */
const GATEWAYS: readonly ShotFixture[] = [
  fixture('/payment-gateways', paymentGatewayListResponseSchema, {
    gateways: [
      route({
        provider: 'MANUAL_TRANSFER',
        minAmountMinor: '50000',
        maxAmountMinor: '20000000',
        updatedAt: ago(60 * 24 * 3 + 60),
      }),
      route({
        provider: 'TONPAYS',
        displayName: 'پرداخت آنلاین (شتاب)',
        minAmountMinor: '100000',
        topupCashbackPercent: 2,
        credential: { required: true, setAt: ago(60 * 24 * 12) },
        callbackUrl: 'https://admin.nexa.example/api/payments/tonpays/callback',
        sortOrder: 1,
        updatedAt: ago(60 * 24 * 4),
      }),
      route({
        provider: 'TELEGRAM_STARS',
        allowWalletTopup: false,
        eligibility: {
          activateAfterPayments: 1,
          deactivateAfterPayments: 0,
          activateAfterAccountDays: 0,
        },
        sortOrder: 2,
        updatedAt: ago(60 * 24 * 7),
      }),
      route({
        provider: 'TONPAYS_TELEGRAM',
        status: 'DISABLED',
        credential: { required: true, setAt: null },
        sortOrder: 3,
        updatedAt: ago(60 * 24 * 10),
      }),
      route({
        provider: 'NOWPAYMENTS',
        displayName: 'ارز دیجیتال (تتر و ترون)',
        minAmountMinor: '300000',
        customerFeeBasisPoints: 150,
        eligibility: {
          activateAfterPayments: 2,
          deactivateAfterPayments: 0,
          activateAfterAccountDays: 7,
        },
        credential: {
          required: true,
          setAt: ago(60 * 24 * 9),
          webhookSecretRequired: true,
          webhookSecretSetAt: ago(60 * 24 * 9 - 2),
          lastCheckAt: ago(60 * 24 + 30),
          lastCheckResult: 'ok',
        },
        sortOrder: 4,
        updatedAt: ago(60 * 24 + 30),
      }),
      route({
        provider: 'CENTRALPAY',
        status: 'DISABLED',
        allowServicePurchase: false,
        allowWalletTopup: false,
        topupCashbackPercent: 3,
        credential: {
          required: true,
          setAt: ago(60 * 24 * 6),
          verifyKeyRequired: true,
          verifyKeySetAt: null,
        },
        sortOrder: 5,
        updatedAt: ago(60 * 24 * 6),
      }),
    ],
    walletTopup: {
      available: true,
      routes: [
        { provider: 'MANUAL_TRANSFER', blockers: [] },
        { provider: 'TONPAYS', blockers: [] },
        { provider: 'TELEGRAM_STARS', blockers: ['PURPOSE_OFF'] },
        { provider: 'TONPAYS_TELEGRAM', blockers: ['INACTIVE'] },
        { provider: 'NOWPAYMENTS', blockers: [] },
        { provider: 'CENTRALPAY', blockers: ['INACTIVE', 'PURPOSE_OFF'] },
      ],
    },
  }),
  // The demo's central rate: 98,450 toman, 42 seconds old, Wallex failing three times.
  fixture('/fx/status', fxStatusResponseSchema, {
    enabled: true,
    baseAsset: 'USDT',
    quoteCurrency: 'IRT',
    side: 'SELL_USDT_TO_RECEIVE_FIAT',
    primarySource: 'NOBITEX',
    fallbackSource: 'WALLEX',
    freshTtlSeconds: 300,
    maxStaleSeconds: 1800,
    state: 'FRESH',
    quote: {
      quoteId: '01a0f1c2-0000-7000-8000-00000000f002',
      source: 'NOBITEX',
      rate: '98450',
      rateMantissa: '98450',
      rateScale: 0,
      sourceAt: ago(1),
      fetchedAt: ago(1),
      ageSeconds: 42,
      policyVersion: 4,
    },
    lastAttemptAt: ago(1),
    lastErrorCode: null,
    sources: [
      {
        source: 'NOBITEX',
        lastSuccessAt: ago(1),
        lastFailureAt: ago(60 * 24 + 60 * 11),
        lastFailureCode: 'fx.source_unavailable',
        retryAfter: null,
        consecutiveFailures: 0,
      },
      {
        source: 'WALLEX',
        lastSuccessAt: ago(60 * 5),
        lastFailureAt: ago(33),
        lastFailureCode: 'fx.quote_rejected',
        retryAfter: ago(-9),
        consecutiveFailures: 3,
      },
    ],
    stars: {
      pricingMode: 'CENTRAL_FX_RATIO',
      starsPerUsdt: '60',
      fixedRateMinor: null,
      centralRatePerStar: '1640.83',
    },
    policyVersion: 4,
  }),
];

export const DEMO_FINANCE: readonly ShotFixture[] = [...PAYMENTS, ...GATEWAYS];
