import {
  campaignListResponseSchema,
  fxStatusResponseSchema,
  paymentGatewayListResponseSchema,
  paymentListResponseSchema,
  referralCommissionListResponseSchema,
  referralListResponseSchema,
  reportReferralsResponseSchema,
  reportSummaryResponseSchema,
  reportTrendResponseSchema,
  resellerListResponseSchema,
  resellerMinimumReportSchema,
  resellerTierListResponseSchema,
  paymentSituationOf,
  type PaymentSituationFacts,
} from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../../fixture.ts';
import { CATEGORIES } from '../commerce-b.ts';

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
    lateCredited: false,
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
    minAgreeingSources: 2,
    acceptSingleSource: false,
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
        enabled: true,
        lastSuccessAt: ago(1),
        lastFailureAt: ago(60 * 24 + 60 * 11),
        lastFailureCode: 'fx.source_unavailable',
        retryAfter: null,
        consecutiveFailures: 0,
      },
      {
        source: 'WALLEX',
        enabled: true,
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

// --- referrals (`#/referrals`) -------------------------------------------------

/** The demo's people: a display name and a Telegram id, as its tables show them. */
const PEOPLE: readonly (readonly [string | null, string])[] = [
  ['علی رضایی', '606935783'],
  ['رضا نوری', '872170802'],
  ['زهرا جعفری', '982530490'],
  ['فاطمه کاظمی', '403962768'],
  ['مهدی کریمی', '584271451'],
  ['پویا شریفی', '999546491'],
  ['مریم صادقی', '584332434'],
  [null, '673267723'],
  ['حسین موسوی', '319675910'],
  ['کیان فرهادی', '484648889'],
  ['سارا محمدی', '959498386'],
  ['ندا رستمی', '291406883'],
  ['امیر حسینی', '767614693'],
  ['بهنام طاهری', '719319299'],
  ['نگار احمدی', '495954583'],
  ['شیما عباسی', '172128502'],
  ['فرهاد یزدانی', '676309375'],
  ['لیلا اکبری', '542733367'],
  ['سینا مرادی', '488820628'],
  ['میلاد زارعی', '851500034'],
  ['پریسا حیدری', '513033985'],
];

function person(index: number): Json {
  const [name, telegram] = PEOPLE[index % PEOPLE.length] ?? [null, '0'];
  return { customerId: uid('0199a0ab', index), telegramUserId: telegram, displayName: name };
}

/** Referrer, referee and scope of the demo's attribution rows, newest first. */
const ATTRIBUTIONS: readonly (readonly [
  number,
  number,
  'ON_FIRST_PAID_ORDER' | 'ON_EVERY_PAID_ORDER',
])[] = [
  [0, 1, 'ON_EVERY_PAID_ORDER'],
  [2, 3, 'ON_FIRST_PAID_ORDER'],
  [4, 5, 'ON_FIRST_PAID_ORDER'],
  [6, 7, 'ON_FIRST_PAID_ORDER'],
  [8, 9, 'ON_EVERY_PAID_ORDER'],
  [10, 11, 'ON_FIRST_PAID_ORDER'],
  [12, 13, 'ON_FIRST_PAID_ORDER'],
  [14, 15, 'ON_FIRST_PAID_ORDER'],
  [0, 16, 'ON_EVERY_PAID_ORDER'],
  [2, 17, 'ON_FIRST_PAID_ORDER'],
];

const REFERRAL_ROWS: readonly Json[] = ATTRIBUTIONS.map(([referrer, referee, trigger], index) => ({
  id: uid('0199b0ab', index),
  referrer: person(referrer),
  referee: person(referee),
  trigger,
  createdAt: ago(60 * 24 * index + 60 * (index * 3)),
}));

/** The demo's ledger: state, percent, basis, scope, reversal — in its order. */
const LEDGER: readonly (readonly [
  string,
  number,
  number,
  'FIRST_PAID_ORDER' | 'EVERY_PAID_ORDER',
  number,
])[] = [
  ['EARNED', 10, 310000, 'EVERY_PAID_ORDER', 0],
  ['PENDING', 15, 490000, 'FIRST_PAID_ORDER', 0],
  ['VOID', 15, 250000, 'FIRST_PAID_ORDER', 0],
  ['EARNED', 10, 1450000, 'EVERY_PAID_ORDER', 145000],
  ['PENDING', 15, 490000, 'FIRST_PAID_ORDER', 0],
  ['EARNED', 15, 780000, 'FIRST_PAID_ORDER', 0],
  ['EARNED', 15, 1450000, 'FIRST_PAID_ORDER', 108750],
  ['VOID', 15, 310000, 'FIRST_PAID_ORDER', 0],
  ['EARNED', 10, 780000, 'EVERY_PAID_ORDER', 0],
  ['EARNED', 15, 250000, 'FIRST_PAID_ORDER', 0],
];

const COMMISSION_ROWS: readonly Json[] = LEDGER.map(
  ([state, percent, basis, scope, reversed], index) => {
    const promised = Math.round((basis * percent) / 100);
    return {
      id: uid('0199c0ab', index),
      referralId: uid('0199b0ab', index),
      orderId: uid(`0${String(5216 - index * 3)}abc`, index),
      referrer: person((index * 2) % 20),
      referee: person((index * 2 + 1) % 20),
      scope,
      percent,
      basisAmount: String(basis),
      promisedAmount: String(promised),
      currency: 'IRT',
      state,
      earnedAmount: state === 'EARNED' ? String(promised) : null,
      reversedAmount: String(reversed),
      unrecoveredAmount: index === 6 ? '20000' : '0',
      createdAt: ago(60 * 24 * index + 60 * 5),
      earnedAt: state === 'EARNED' ? ago(60 * 24 * index) : null,
      voidedAt: state === 'VOID' ? ago(60 * 24 * index) : null,
      notBefore: null,
    };
  },
);

/** The demo's «۳۰ روز اخیر» window, 1405/06/17 – 1405/07/15, beside the one before it. */
const LAST_30_DAYS = {
  range: 'LAST_30_DAYS',
  timezone: 'Asia/Tehran',
  calendar: 'jalali',
  granularity: 'DAY',
  current: {
    start: '2026-08-07T20:30:00.000Z',
    end: '2026-09-06T20:30:00.000Z',
    effectiveEnd: '2026-09-06T08:00:00.000Z',
    startLocal: '1405/05/17',
    endLocalInclusive: '1405/06/15',
  },
  previous: {
    start: '2026-07-08T20:30:00.000Z',
    end: '2026-08-07T20:30:00.000Z',
    effectiveEnd: '2026-08-07T08:00:00.000Z',
    startLocal: '1405/04/16',
    endLocalInclusive: '1405/05/16',
  },
  lengthsDiffer: false,
  generatedAt: ago(0),
};

/** The demo's top referrers: signups, buyers, revenue and commission, eight of them. */
const TOP: readonly (readonly [number, number, number, number])[] = [
  [21, 8, 2864400, 343728],
  [19, 8, 2591600, 310992],
  [13, 5, 1773200, 212784],
  [10, 4, 1364000, 163680],
  [10, 4, 1364000, 163680],
  [8, 3, 1091200, 130944],
  [5, 2, 682000, 81840],
  [3, 1, 409200, 49104],
];

const REFERRALS: readonly ShotFixture[] = [
  fixture('/referrals', referralListResponseSchema, {
    referrals: REFERRAL_ROWS,
    nextCursor: 'ref-2',
  }),
  fixture('/referral-commissions', referralCommissionListResponseSchema, {
    commissions: COMMISSION_ROWS,
    nextCursor: 'com-2',
  }),
  fixture('/reports/referrals', reportReferralsResponseSchema, {
    period: LAST_30_DAYS,
    signups: { current: 93, previous: 84 },
    convertedBuyers: 35,
    conversionBasisPoints: 3_763,
    signupGifts: [{ currency: 'IRT', amount: '1860000', entries: 93 }],
    commissions: [{ currency: 'IRT', amount: '1432200', entries: 35 }],
    commissionReversals: [],
    referredSales: 46,
    referredRevenue: [{ currency: 'IRT', amount: '11935000' }],
    topReferrers: {
      by: 'SIGNUPS',
      rankingCurrency: 'IRT',
      page: 1,
      limit: 10,
      totalRows: TOP.length,
      rows: TOP.map(([signups, buyers, revenue, commission], index) => ({
        rank: index + 1,
        referrerId: uid('0199a0ab', index * 2),
        signups,
        convertedBuyers: buyers,
        revenue: [{ currency: 'IRT', amount: String(revenue) }],
        commission: [{ currency: 'IRT', amount: String(commission) }],
      })),
    },
  }),
];

// --- reports (`#/reports`, «این ماه») --------------------------------------------

const DAY_MS = 24 * 3_600_000;
/** Tehran's midnight on the first of Mehr 1405 (the demo's «این ماه» starts 1405/07/01). */
const MONTH_START = Date.parse('2026-09-22T20:30:00.000Z') - 30 * DAY_MS;
const THIS_MONTH = {
  range: 'THIS_MONTH',
  timezone: 'Asia/Tehran',
  calendar: 'jalali',
  granularity: 'DAY',
  current: {
    start: new Date(MONTH_START).toISOString(),
    end: new Date(MONTH_START + 30 * DAY_MS).toISOString(),
    effectiveEnd: ago(0),
    startLocal: '1405/07/01',
    endLocalInclusive: '1405/07/30',
  },
  previous: {
    start: new Date(MONTH_START - 31 * DAY_MS).toISOString(),
    end: new Date(MONTH_START).toISOString(),
    effectiveEnd: new Date(MONTH_START - 16 * DAY_MS).toISOString(),
    startLocal: '1405/06/01',
    endLocalInclusive: '1405/06/31',
  },
  lengthsDiffer: true,
  generatedAt: ago(0),
};

/** The demo's daily revenue this month (fifteen days so far) and the month before. */
const TREND_CURRENT = [
  17200000, 12100000, 13400000, 16100000, 11600000, 13300000, 17400000, 11300000, 14700000,
  12800000, 12700000, 11100000, 15100000, 15200000, 11800000,
];
const TREND_PREVIOUS = [
  13900000, 13600000, 13900000, 13000000, 14300000, 14100000, 13600000, 12600000, 13400000,
  12200000, 9900000, 12900000, 15200000, 13100000, 12400000, 9600000, 11300000, 12200000, 11400000,
  11700000, 12300000, 12300000, 13600000, 11300000, 12200000, 12400000, 13900000, 16200000,
  15700000, 13500000,
];

function monthBuckets(values: readonly (number | null)[], start: number, month: string) {
  return Array.from({ length: 30 }, (_, index) => ({
    index,
    start: new Date(start + index * DAY_MS).toISOString(),
    end: new Date(start + (index + 1) * DAY_MS).toISOString(),
    label: `1405/${month}/${String(index + 1).padStart(2, '0')}`,
    value: values[index] === undefined || values[index] === null ? null : String(values[index]),
  }));
}

const irtCmp = (current: number, previous: number) => [
  { currency: 'IRT', current: String(current), previous: String(previous) },
];

const REPORTS: readonly ShotFixture[] = [
  fixture(
    '/reports/summary',
    reportSummaryResponseSchema,
    {
      period: THIS_MONTH,
      sales: { current: 670, previous: 1291 },
      revenue: irtCmp(204_489_678, 400_175_495),
      grossValue: irtCmp(216_963_548, 412_000_000),
      discount: irtCmp(12_473_870, 11_825_000),
      successfulOrders: { current: 1202, previous: 2243 },
      newUsers: { current: 1717, previous: 3283 },
      newBuyers: { current: 309, previous: 598 },
      newServices: { current: 288, previous: 528 },
      newTrialServices: { current: 532, previous: 1015 },
      renewals: { current: 266, previous: 547 },
      walletTopupCount: { current: 435, previous: 401 },
      walletTopup: irtCmp(89_700_589, 84_068_000),
      activeServices: 1873,
      activeCustomers: 1544,
    },
    { query: { range: 'THIS_MONTH' } },
  ),
  fixture(
    '/reports/trend',
    reportTrendResponseSchema,
    {
      period: THIS_MONTH,
      metric: 'REVENUE',
      currency: 'IRT',
      currencies: ['IRT'],
      current: monthBuckets(TREND_CURRENT, MONTH_START, '07'),
      previous: monthBuckets(TREND_PREVIOUS, MONTH_START - 31 * DAY_MS, '06'),
    },
    { query: { range: 'THIS_MONTH', metric: 'REVENUE' } },
  ),
];

// --- campaigns (`#/campaigns`) -------------------------------------------------

type CampaignRow = readonly [
  name: string,
  state: string,
  actions: readonly string[],
  start: readonly [string, string],
  end: readonly [string, string],
  confirmed: number | null,
];

/** The demo's ten campaigns, every state among them, in its order. */
const DEMO_CAMPAIGNS: readonly CampaignRow[] = [
  [
    'جشنوارهٔ پاییز ۱۴۰۵',
    'ACTIVE',
    ['DISCOUNT', 'ANNOUNCEMENT'],
    ['1405-07-10', '10:00'],
    ['1405-07-25', '23:59'],
    6214,
  ],
  [
    'جبران قطعی DE-2',
    'COMPLETED',
    ['TRAFFIC_GIFT', 'TIME_GIFT'],
    ['1405-07-14', '18:00'],
    ['1405-07-15', '18:00'],
    611,
  ],
  [
    'هدیهٔ کیف پول مشتریان وفادار',
    'PAUSED',
    ['CASHBACK', 'WALLET_GIFT'],
    ['1405-07-08', '09:00'],
    ['1405-07-28', '23:00'],
    1240,
  ],
  [
    'بازگشت مشتریان غیرفعال',
    'SCHEDULED',
    ['DISCOUNT'],
    ['1405-07-20', '10:00'],
    ['1405-08-05', '10:00'],
    2031,
  ],
  [
    'یلدا ۱۴۰۵',
    'DRAFT',
    ['DISCOUNT', 'ANNOUNCEMENT'],
    ['1405-09-30', '23:59'],
    ['1405-10-02', '23:59'],
    null,
  ],
  [
    'تمدید زودهنگام آبان',
    'DRAFT',
    ['CASHBACK', 'WALLET_GIFT'],
    ['1405-08-01', '00:00'],
    ['1405-08-10', '23:59'],
    null,
  ],
  [
    'کمپین نوروز ۱۴۰۵',
    'COMPLETED',
    ['DISCOUNT', 'ANNOUNCEMENT'],
    ['1405-01-01', '00:00'],
    ['1405-01-13', '23:59'],
    5120,
  ],
  [
    'آزمایش کد تخفیف تلگرام',
    'CANCELLED',
    ['DISCOUNT'],
    ['1405-07-05', '12:00'],
    ['1405-07-06', '12:00'],
    12,
  ],
  [
    'فروش ویژهٔ نمایندگان',
    'ACTIVE',
    ['DISCOUNT', 'WALLET_GIFT'],
    ['1405-07-12', '08:00'],
    ['1405-07-22', '08:00'],
    96,
  ],
  [
    'هفتهٔ سرویس نامحدود',
    'COMPLETED',
    ['CASHBACK'],
    ['1405-06-20', '10:00'],
    ['1405-06-27', '10:00'],
    4410,
  ],
];

const CAMPAIGN_ROWS: readonly Json[] = DEMO_CAMPAIGNS.map(
  ([name, state, actionKinds, start, end, confirmed], index) => {
    const launched = state !== 'DRAFT' && state !== 'SCHEDULED';
    return {
      id: uid('0199d0ab', index),
      name,
      description: '',
      state,
      startsAt: ago(-60 * 24 * (index + 1)),
      endsAt: ago(-60 * 24 * (index + 10)),
      startLocal: { date: start[0], time: start[1] },
      endLocal: { date: end[0], time: end[1] },
      audienceConfirmedCount: confirmed,
      actionKinds,
      scheduledAt: state === 'DRAFT' ? null : ago(60 * 24 * (index + 2)),
      startedAt: launched ? ago(60 * 24 * (index + 1)) : null,
      pausedAt: state === 'PAUSED' ? ago(60 * 5) : null,
      completedAt: state === 'COMPLETED' ? ago(60 * 24 * index) : null,
      cancelledAt: state === 'CANCELLED' ? ago(60 * 24 * index) : null,
      createdAt: ago(60 * 24 * (index + 20)),
      updatedAt: ago(60 * index),
    };
  },
);

const CAMPAIGNS: readonly ShotFixture[] = [
  fixture('/campaigns', campaignListResponseSchema, {
    campaigns: CAMPAIGN_ROWS,
    nextCursor: 'camp-2',
    presentation: { timezone: 'Asia/Tehran', calendar: 'jalali' },
  }),
];

// --- resellers, plans and tiers (`#/resellers`, `#/reseller-plans`, `#/reseller-tiers`) ---

/** The default registry's panels, categories and bot, so every grant resolves to a name. */
const PANEL_DE = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
const PANEL_NL = '01a05e35-c9ad-7e93-bef3-1ed9b55292c9';
const CATEGORY_A = CATEGORIES[0]?.['id'] as string;
const CATEGORY_B = CATEGORIES[1]?.['id'] as string;

function tierRow(
  index: number,
  name: string,
  pricing: readonly [string, number | null],
  grants: readonly Json[],
  resellerCount: number,
  minimum: string | null,
): Json {
  return {
    id: uid('0199f0ab', index),
    name,
    pricingMode: pricing[0],
    discountPercentage: pricing[1],
    creditLimit: { amount: '0', currency: 'IRT' },
    grants,
    resellerCount,
    monthlyMinimum: minimum === null ? null : { amount: minimum, currency: 'IRT' },
    createdAt: ago(60 * 24 * 200),
    updatedAt: ago(60 * 24 * 20),
  };
}

/** The demo's four tiers: «برنزی» (two categories, two purchase types), «نقره‌ای», «طلایی», «آزمایشی» (nothing). */
const TIER_ROWS: readonly Json[] = [
  tierRow(
    1,
    'برنزی',
    ['LIST_PRICE', null],
    [
      { kind: 'CATEGORY', subject: CATEGORY_A },
      { kind: 'CATEGORY', subject: CATEGORY_B },
      { kind: 'PANEL', subject: null },
      { kind: 'BOT', subject: null },
      { kind: 'OPERATION', subject: 'NEW_SERVICE' },
      { kind: 'OPERATION', subject: 'RENEW' },
    ],
    4,
    null,
  ),
  tierRow(
    2,
    'نقره‌ای',
    ['PERCENTAGE_DISCOUNT', 10],
    [
      { kind: 'PRODUCT', subject: null },
      { kind: 'PANEL', subject: PANEL_DE },
      { kind: 'PANEL', subject: PANEL_NL },
      { kind: 'BOT', subject: '01900000-0000-7000-8000-00000000b001' },
      { kind: 'OPERATION', subject: null },
    ],
    4,
    '30000000',
  ),
  tierRow(
    3,
    'طلایی',
    ['PERCENTAGE_DISCOUNT', 20],
    [
      { kind: 'PRODUCT', subject: null },
      { kind: 'CATEGORY', subject: null },
      { kind: 'PANEL', subject: null },
      { kind: 'BOT', subject: null },
      { kind: 'OPERATION', subject: null },
    ],
    2,
    '80000000',
  ),
  tierRow(4, 'آزمایشی', ['LIST_PRICE', null], [], 1, null),
];

const tierOf = (index: number) => {
  const tier = TIER_ROWS[index] ?? {};
  return { id: tier['id'], name: tier['name'] };
};

type ResellerSeed = readonly [
  person: number,
  tier: number,
  status: string,
  mode: string,
  percent: number | null,
];

/** The demo's ten resellers, in its order: two suspended, one own discount, one list price. */
const RESELLER_SEEDS: readonly ResellerSeed[] = [
  [0, 0, 'ACTIVE', 'TIER', null],
  [10, 1, 'ACTIVE', 'TIER', null],
  [4, 2, 'ACTIVE', 'PERCENTAGE_DISCOUNT', 25],
  [14, 1, 'ACTIVE', 'TIER', null],
  [8, 0, 'ACTIVE', 'TIER', null],
  [2, 1, 'ACTIVE', 'TIER', null],
  [12, 2, 'SUSPENDED', 'TIER', null],
  [1, 0, 'ACTIVE', 'LIST_PRICE', null],
  [3, 1, 'ACTIVE', 'TIER', null],
  [5, 3, 'SUSPENDED', 'TIER', null],
];

const RESELLER_ROWS: readonly Json[] = RESELLER_SEEDS.map(
  ([who, tier, status, mode, percent], index) => {
    const one = person(who);
    return {
      customerId: one['customerId'],
      telegramUserId: one['telegramUserId'],
      displayName: who === 8 ? null : one['displayName'],
      tier: tierOf(tier),
      status,
      pricingMode: mode,
      discountPercentage: percent,
      creditLimit: null,
      effectiveCreditLimit: { amount: '0', currency: 'IRT' },
      createdAt: ago(60 * 24 * (120 - index * 7)),
      updatedAt: ago(60 * 24 * index),
    };
  },
);

const IRT = (amount: string) => ({ amount, currency: 'IRT' });

type MinimumSeed = readonly [
  reseller: number,
  minimum: string | null,
  source: string,
  achieved: string,
];

/** The demo's progress rows: eleven, so the table pages; the suspended ones «نمایندگی معلق». */
const MINIMUM_SEEDS: readonly MinimumSeed[] = [
  [0, null, 'NONE', '42000000'],
  [1, '50000000', 'RESELLER', '53000000'],
  [2, '80000000', 'TIER', '25000000'],
  [3, '30000000', 'TIER', '23000000'],
  [4, null, 'NONE', '24000000'],
  [5, null, 'NONE', '55000000'],
  [6, '80000000', 'TIER', '25000000'],
  [7, null, 'NONE', '27000000'],
  [8, '30000000', 'TIER', '34000000'],
  [9, null, 'NONE', '48000000'],
  [3, '30000000', 'TIER', '31000000'],
];

const MINIMUM_ROWS: readonly Json[] = MINIMUM_SEEDS.map(([index, minimum, source, achieved], n) => {
  const reseller = RESELLER_ROWS[index] ?? {};
  const suspended = reseller['status'] !== 'ACTIVE';
  const min = minimum === null ? null : BigInt(minimum);
  const got = BigInt(achieved);
  const state = suspended
    ? 'NOT_ACTIVE'
    : min === null
      ? 'NO_MINIMUM'
      : got >= min
        ? 'ACHIEVED'
        : 'BELOW';
  return {
    customerId: n === 10 ? uid('0199a0ab', 30) : reseller['customerId'],
    telegramUserId: reseller['telegramUserId'],
    displayName: n === 10 ? 'کیان فرهادی' : reseller['displayName'],
    tier: reseller['tier'],
    status: reseller['status'],
    minimum: suspended || min === null ? null : IRT(minimum ?? '0'),
    source: suspended ? 'NONE' : source,
    achieved: IRT(achieved),
    remaining: suspended || min === null ? null : IRT(String(got >= min ? 0n : min - got)),
    progressBasisPoints: suspended || min === null ? null : Number((got * 10_000n) / min),
    state,
  };
});

const RESELLERS: readonly ShotFixture[] = [
  fixture('/reseller-tiers', resellerTierListResponseSchema, { tiers: TIER_ROWS }),
  fixture('/resellers', resellerListResponseSchema, {
    resellers: RESELLER_ROWS,
    nextCursor: 'res-2',
  }),
  fixture('/reseller-minimums', resellerMinimumReportSchema, {
    period: {
      key: 'THIS_MONTH',
      start: '2026-08-22T20:30:00.000Z',
      end: '2026-09-22T20:30:00.000Z',
      startLocal: '1405/07/01',
      endLocalInclusive: '1405/07/30',
      timezone: 'Asia/Tehran',
      calendar: 'jalali',
      running: true,
    },
    rows: MINIMUM_ROWS,
    counts: {
      achieved: MINIMUM_ROWS.filter((row) => row['state'] === 'ACHIEVED').length,
      below: MINIMUM_ROWS.filter((row) => row['state'] === 'BELOW').length,
      noMinimum: MINIMUM_ROWS.filter((row) => row['state'] === 'NO_MINIMUM').length,
      notActive: MINIMUM_ROWS.filter((row) => row['state'] === 'NOT_ACTIVE').length,
    },
    truncated: false,
  }),
];

export const DEMO_FINANCE: readonly ShotFixture[] = [
  ...RESELLERS,
  ...CAMPAIGNS,
  ...PAYMENTS,
  ...GATEWAYS,
  ...REFERRALS,
  ...REPORTS,
];
