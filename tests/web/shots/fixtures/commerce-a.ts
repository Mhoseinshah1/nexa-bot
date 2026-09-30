import {
  SERVICE_OPERATOR_ACTIONS,
  compensationListResponseSchema,
  customerListResponseSchema,
  customerReferralResponseSchema,
  customerResponseSchema,
  errorResponseSchema,
  orderListResponseSchema,
  orderPricingResponseSchema,
  orderResponseSchema,
  panelTrialOverviewResponseSchema,
  paymentListResponseSchema,
  paymentReceiptListResponseSchema,
  paymentResponseSchema,
  paymentTimelineResponseSchema,
  refundListResponseSchema,
  serviceListResponseSchema,
  serviceOperationsResponseSchema,
  serviceRefundRequestListResponseSchema,
  serviceResponseSchema,
  trialAllowanceResponseSchema,
  trialOverrideListResponseSchema,
  trialResetListResponseSchema,
  walletEntryListResponseSchema,
  walletResponseSchema,
} from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../fixture.ts';

/*
 * Page family COMMERCE-A: users, trials, services, orders, payments,
 * compensations — every list and detail route, answered from the frozen
 * contract's own schemas so `pnpm web:shots` photographs real states.
 *
 * Shot routes (the first row of each list is its detail):
 *   /users/019210ab-cdef-7012-8345-6789abcdef01
 *   /services/019250ab-cdef-7012-8345-6789abcdef01
 *   /orders/019230ab-cdef-7012-8345-6789abcdef01
 *   /payments/019240ab-cdef-7012-8345-6789abcdef01
 */

type Json = Record<string, unknown>;

/** A uuidv7-shaped id in one of the family's namespaces, `index` in the last group. */
function uid(prefix: string, index: number): string {
  return `${prefix}-cdef-7012-8345-${String(6789 + index).padStart(4, '0')}abcdef01`;
}

const ADMIN_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
const PANELS = [
  '01a05e35-c9ad-7e93-bef3-1ed9b55292c9',
  '01a05e35-c9ad-7e93-bef3-1ed9b55292ca',
  '01a05e35-c9ad-7e93-bef3-1ed9b55292cb',
];
const PRODUCTS = ['019220ab-cdef-7012-8345-6789abcdef01', '019220ab-cdef-7012-8345-6790abcdef01'];

/** One customer, in `customerSummarySchema`'s shape — the web suite's `customer()`. */
export function customer(index: number, over: Json = {}): Json {
  const id = uid('019210ab', index);
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
const CUSTOMER_0 = uid('019210ab', 0);

// --- orders -----------------------------------------------------------------

const TITLES = ['پلن یک‌ماهه ۵۰ گیگ', 'پلن سه‌ماهه نامحدود', 'افزودن ۲۰ گیگ حجم', 'تمدید یک‌ماهه'];
const ORDER_STATES = [
  'PAID',
  'AWAITING_PAYMENT',
  'PAID',
  'REFUNDED',
  'EXPIRED',
  'CANCELLED',
  'DRAFT',
];
const PURPOSES = ['NEW_SERVICE', 'NEW_SERVICE', 'ADD_TRAFFIC', 'RENEW'];

function order(index: number, over: Json = {}): Json {
  const price = String(150000 + (index % 4) * 95000);
  const state = ORDER_STATES[index % ORDER_STATES.length];
  const discount = index === 0 ? '37500' : '0';
  return {
    id: uid('019230ab', index),
    customerId: uid('019210ab', index % 6),
    state,
    purpose: PURPOSES[index % PURPOSES.length],
    productId: PRODUCTS[index % 2],
    panelId: PANELS[index % 3],
    lineTitle: TITLES[index % TITLES.length],
    lineCategoryId: '01a05e35-c9ad-7e93-bef3-1ed9b55292cd',
    lineCategoryName: 'عمومی',
    lineCategoryEmoji: '🌐',
    lineDurationDays: index % 4 === 1 ? 90 : 30,
    lineTrafficBytes: index % 4 === 1 ? '9223372036854775807' : '53687091200',
    lineDeviceLimit: index % 3 === 0 ? 2 : null,
    lineUnitPriceAmount: price,
    lineQuantity: 1,
    subtotalAmount: price,
    discountAmount: discount,
    totalAmount: String(BigInt(price) - BigInt(discount)),
    currency: 'IRT',
    expiresAt: state === 'AWAITING_PAYMENT' ? ago(-45) : null,
    confirmedAt: state === 'DRAFT' ? null : ago(60 * (index * 7 + 3) - 2),
    settledAt: state === 'PAID' || state === 'REFUNDED' ? ago(60 * (index * 7 + 3) - 5) : null,
    createdAt: ago(60 * (index * 7 + 3)),
    updatedAt: ago(60 * (index * 7 + 3) - 5),
    ...over,
  };
}

const ORDERS: readonly Json[] = Array.from({ length: 12 }, (_, index) => order(index));
const ORDER_0 = uid('019230ab', 0);

// --- services ---------------------------------------------------------------

const SERVICE_STATES = ['ACTIVE', 'ACTIVE', 'SUSPENDED', 'ACTIVE', 'EXPIRED', 'PENDING_PROVISION'];
const DELIVERY = ['DELIVERED', 'DELIVERED', 'DELIVERED', 'FAILED', 'DELIVERED', 'PENDING'];

function service(index: number, over: Json = {}): Json {
  const state = SERVICE_STATES[index % SERVICE_STATES.length];
  return {
    id: uid('019250ab', index),
    customerId: uid('019210ab', index % 6),
    orderId: uid('019230ab', index),
    panelId: PANELS[index % 3],
    productId: PRODUCTS[index % 2],
    state,
    providerUsername: `nx_${(0x7f3a91 + index * 4099).toString(16)}`,
    providerUserId: state === 'PENDING_PROVISION' ? null : String(4821 + index),
    hasSubscription: state !== 'PENDING_PROVISION',
    isTrial: index === 2,
    expiresAt: state === 'PENDING_PROVISION' ? null : ago(-60 * 24 * (22 - index)),
    trafficLimitBytes: index % 4 === 1 ? '9223372036854775807' : '53687091200',
    trafficUsedBytes: String(BigInt(1073741824) * BigInt(7 + index * 5)),
    deviceLimit: index % 3 === 0 ? 2 : null,
    usageSyncedAt: state === 'PENDING_PROVISION' ? null : ago(12 + index),
    deliveryState: DELIVERY[index % DELIVERY.length],
    deliveredAt: DELIVERY[index % DELIVERY.length] === 'DELIVERED' ? ago(60 * 24 * 8) : null,
    provisionedAt: state === 'PENDING_PROVISION' ? null : ago(60 * 24 * 8 + 1),
    terminatedAt: null,
    createdAt: ago(60 * 24 * 8 + 3 + index * 90),
    updatedAt: ago(30 + index),
    ...over,
  };
}

const SERVICES: readonly Json[] = Array.from({ length: 12 }, (_, index) => service(index));

/** The server's verdict on every operator action, as `serviceDetailSchema` carries it. */
const SERVICE_ACTIONS = SERVICE_OPERATOR_ACTIONS.map((action) => {
  if (action === 'RETRY_PROVISION') return { action, available: false, blocker: 'STATE' };
  if (action === 'RESUME') return { action, available: false, blocker: 'STATE' };
  if (action === 'ROTATE_LINK') return { action, available: false, blocker: 'CAPABILITY' };
  return { action, available: true, blocker: null };
});

function operation(index: number, over: Json = {}): Json {
  return {
    id: uid('019260cd', index),
    type: 'PROVISION',
    state: 'SUCCEEDED',
    attempts: 1,
    failureMessage: null,
    scheduledAt: null,
    startedAt: ago(60 * 24 * 8 + 2),
    completedAt: ago(60 * 24 * 8 + 1),
    createdAt: ago(60 * 24 * 8 + 3),
    ...over,
  };
}

const OPERATIONS: readonly Json[] = [
  operation(3, {
    type: 'SYNC_USAGE',
    createdAt: ago(14),
    startedAt: ago(13),
    completedAt: ago(12),
  }),
  operation(2, {
    type: 'SUSPEND',
    state: 'FAILED',
    attempts: 3,
    failureMessage: 'panel answered 502 Bad Gateway',
    createdAt: ago(60 * 26),
    startedAt: ago(60 * 26 - 1),
    completedAt: ago(60 * 25),
  }),
  operation(1, {
    type: 'ADD_TRAFFIC',
    createdAt: ago(60 * 24 * 3),
    startedAt: ago(60 * 24 * 3 - 1),
    completedAt: ago(60 * 24 * 3 - 2),
  }),
  operation(0),
];

// --- payments ---------------------------------------------------------------

const PAYMENT_STATES = ['CONFIRMED', 'PENDING', 'CONFIRMED', 'FAILED', 'UNKNOWN', 'EXPIRED'];
const METHODS = ['MANUAL_TRANSFER', 'WALLET', 'GATEWAY', 'MANUAL_TRANSFER', 'GATEWAY', 'WALLET'];

function payment(index: number, over: Json = {}): Json {
  const state = PAYMENT_STATES[index % PAYMENT_STATES.length];
  const method = METHODS[index % METHODS.length];
  const c = CUSTOMERS[index % 6] as Json;
  const channel = method === 'WALLET' ? 'wallet' : method === 'GATEWAY' ? 'tonpays' : 'manual';
  return {
    id: uid('019240ab', index),
    customerId: c['id'],
    orderId: index === 5 ? null : uid('019230ab', index),
    state,
    method,
    amount: String(150000 + (index % 4) * 95000),
    currency: 'IRT',
    reference: `${(0xa1b2c3d4 + index * 7919).toString(16)}e5f60718:${channel}`,
    evidenceKind: state === 'CONFIRMED' ? 'OPERATOR_REVIEW' : null,
    confirmedAt: state === 'CONFIRMED' ? ago(60 * (index * 5 + 1)) : null,
    confirmedByAdminId: state === 'CONFIRMED' ? ADMIN_ID : null,
    resolvedAt: state === 'FAILED' || state === 'EXPIRED' ? ago(60 * (index * 5 + 1)) : null,
    resolvedByAdminId: state === 'FAILED' ? ADMIN_ID : null,
    customerSignalledAt: method === 'MANUAL_TRANSFER' ? ago(60 * (index * 5 + 2)) : null,
    expiresAt: state === 'PENDING' ? ago(-60) : null,
    createdAt: ago(60 * (index * 5 + 3)),
    updatedAt: ago(60 * (index * 5 + 1)),
    gatewayProvider:
      method === 'GATEWAY' ? 'TONPAYS' : method === 'MANUAL_TRANSFER' ? 'MANUAL_TRANSFER' : null,
    externalReference: method === 'GATEWAY' ? `tp_${String(88120 + index)}` : null,
    customerTelegramUserId: c['telegramUserId'],
    customerUsername: c['username'],
    receiptDisposition:
      method === 'MANUAL_TRANSFER' ? (state === 'FAILED' ? 'REJECTED' : 'APPROVED') : null,
    ...over,
  };
}

const PAYMENTS: readonly Json[] = Array.from({ length: 12 }, (_, index) => payment(index));
const PAYMENT_0 = uid('019240ab', 0);
const RECEIPT_0 = '0192e0ab-cdef-7012-8345-6789abcdef01';

function refundRequest(index: number, over: Json = {}): Json {
  const s = SERVICES[index] as Json;
  const c = CUSTOMERS[index % 6] as Json;
  return {
    id: uid('0192a1ab', index),
    serviceId: s['id'],
    serviceUsername: s['providerUsername'],
    customerId: c['id'],
    customerTelegramUserId: c['telegramUserId'],
    customerUsername: c['username'],
    paymentId: uid('019240ab', index),
    orderId: uid('019230ab', index),
    state: 'OPEN',
    reason: 'سرعت سرویس مناسب نبود',
    principalMinor: '150000',
    remainingMinor: '120000',
    currency: 'IRT',
    approvedAmountMinor: null,
    refundId: null,
    operationId: null,
    operationState: null,
    decidedByAdminId: null,
    decidedAt: null,
    rejectionReason: null,
    failureKind: null,
    createdAt: ago(60 * 5 + index),
    updatedAt: ago(60 * 5 + index),
    resolvedAt: null,
    ...over,
  };
}

const LEDGER: readonly (readonly [string, string, string, string | null, number])[] = [
  ['CREDIT', 'TOPUP_RECEIPT', '500000', null, 60 * 24 * 12],
  ['DEBIT', 'PURCHASE', '250000', null, 60 * 24 * 11],
  ['CREDIT', 'ADMIN_CREDIT', '30000', 'جبران قطعی سرور', 60 * 24 * 4],
  ['DEBIT', 'PURCHASE', '95000', null, 60 * 5],
];

// --- fixtures ---------------------------------------------------------------

export const COMMERCE_A: readonly ShotFixture[] = [
  // Users.
  fixture('/users', customerListResponseSchema, {
    customers: CUSTOMERS,
    nextCursor: 'cursor-page-2',
  }),
  fixture('/users/:id', customerResponseSchema, { customer: CUSTOMERS[0] }),
  fixture('/users/:id/wallet', walletResponseSchema, {
    wallet: { customerId: CUSTOMER_0, balanceAmount: '185000', currency: 'IRT', entryCount: 4 },
  }),
  fixture('/users/:id/wallet/entries', walletEntryListResponseSchema, {
    entries: LEDGER.map(([direction, reason, amount, note, minutes], index) => ({
      id: uid('019290ab', index),
      customerId: CUSTOMER_0,
      direction,
      reason,
      amount,
      currency: 'IRT',
      orderId: reason === 'PURCHASE' ? ORDER_0 : null,
      paymentId: null,
      actorAdminId: reason === 'ADMIN_CREDIT' ? ADMIN_ID : null,
      note,
      createdAt: ago(minutes),
    })),
    nextCursor: null,
  }),
  fixture('/users/:id/trial', trialAllowanceResponseSchema, {
    trial: {
      customerId: CUSTOMER_0,
      featureEnabled: true,
      globalLimit: 1,
      override: null,
      effectiveLimit: 1,
      used: 1,
      remaining: 0,
    },
  }),
  fixture('/users/:id/referral', customerReferralResponseSchema, {
    customerId: CUSTOMER_0,
    code: 'K7QX2M9PDA',
    referredBy: null,
    referredCount: 3,
    totals: [
      {
        currency: 'IRT',
        pendingAmount: '15000',
        earnedAmount: '42000',
        reversedAmount: '0',
        unrecoveredAmount: '0',
      },
    ],
  }),
  // Not a reseller: the server's own 404, which the card reads as «none».
  fixture(
    '/resellers/:id',
    errorResponseSchema,
    {
      error: {
        kind: 'not_found',
        code: 'commerce.reseller_not_found',
        message: 'not a reseller',
        correlationId: 'shot',
      },
    },
    { status: 404 },
  ),
  fixture(
    '/orders',
    orderListResponseSchema,
    { orders: ORDERS.slice(0, 4), nextCursor: null },
    { query: { customerId: CUSTOMER_0 } },
  ),
  fixture(
    '/services',
    serviceListResponseSchema,
    { services: SERVICES.slice(0, 3), nextCursor: null },
    { query: { customerId: CUSTOMER_0 } },
  ),

  // Trials.
  fixture('/trials/panels', panelTrialOverviewResponseSchema, {
    panels: PANELS.map((panelId, index) => ({
      panelId,
      panelName: ['Frankfurt A', 'Amsterdam', 'Tehran relay'][index],
      trial: {
        panelId,
        enabled: index !== 2,
        trafficBytes: index === 1 ? '1073741824' : '104857600',
        durationHours: index === 1 ? 24 : 72,
        label: index === 0 ? 'سرویس تست فرانکفورت' : null,
        revision: 1,
        updatedAt: ago(60 * 24 * 3),
      },
      offeredNow: index === 0,
    })),
  }),
  fixture('/trials/overrides', trialOverrideListResponseSchema, {
    overrides: [1, 3, 7].map((index) => {
      const c = CUSTOMERS[index] as Json;
      return {
        customer: {
          id: c['id'],
          telegramUserId: c['telegramUserId'],
          username: c['username'],
          firstName: c['firstName'],
          status: c['status'],
        },
        limit: index === 3 ? 0 : 3,
        used: 1,
        remaining: index === 3 ? 0 : 2,
        setAt: ago(60 * 24 * index),
      };
    }),
    nextCursor: null,
  }),
  fixture('/trials/resets', trialResetListResponseSchema, {
    resets: [
      {
        id: uid('0192a0ab', 0),
        actorAdminId: ADMIN_ID,
        reason: 'شروع فصل جدید',
        affectedGrants: 41,
        affectedCustomers: 39,
        createdAt: ago(60 * 24 * 30),
      },
    ],
    nextCursor: null,
  }),

  // Services.
  fixture('/services', serviceListResponseSchema, { services: SERVICES, nextCursor: 'svc-2' }),
  fixture('/services/:id', serviceResponseSchema, {
    service: {
      ...SERVICES[0],
      deliveryAttempts: 1,
      deliveryNextAttemptAt: null,
      actions: SERVICE_ACTIONS,
    },
  }),
  fixture('/services/:id/operations', serviceOperationsResponseSchema, {
    operations: OPERATIONS,
    limit: 50,
    hasMore: false,
  }),
  fixture('/services/:id/refund-requests', serviceRefundRequestListResponseSchema, {
    requests: [refundRequest(0)],
    nextCursor: null,
  }),
  fixture(
    '/service-refund-requests',
    serviceRefundRequestListResponseSchema,
    { requests: [refundRequest(0), refundRequest(3, { state: 'EXECUTING' })], nextCursor: null },
    { query: { attention: 'true' } },
  ),

  // Orders.
  fixture('/orders', orderListResponseSchema, { orders: ORDERS, nextCursor: 'ord-2' }),
  fixture('/orders/:id', orderResponseSchema, { order: ORDERS[0] }),
  fixture('/orders/:id/pricing', orderPricingResponseSchema, {
    orderId: ORDER_0,
    discountCode: 'SUMMER25',
    subtotalAmount: '150000',
    discountAmount: '37500',
    totalAmount: '112500',
    currency: 'IRT',
    adjustments: [
      {
        ruleId: '0192b0ab-cdef-7012-8345-6789abcdef01',
        label: 'تخفیف تابستانه',
        amountBefore: '150000',
        amountAfter: '112500',
      },
    ],
    redemptions: [
      {
        discountId: '0192b0ab-cdef-7012-8345-6789abcdef01',
        amount: '37500',
        createdAt: ago(60 * 3 - 1),
      },
    ],
    cashback: {
      ruleId: '0192c0ab-cdef-7012-8345-6789abcdef01',
      label: 'کش‌بک وفاداری',
      percent: 5,
      promisedAmount: '5625',
      state: 'EARNED',
      earnedAmount: '5625',
      reversedAmount: '0',
      unrecoveredAmount: '0',
    },
    reseller: null,
  }),
  fixture(
    '/payments',
    paymentListResponseSchema,
    { payments: [PAYMENTS[0]], nextCursor: null },
    { query: { orderId: ORDER_0 } },
  ),
  fixture(
    '/services',
    serviceListResponseSchema,
    { services: [SERVICES[0]], nextCursor: null },
    { query: { orderId: ORDER_0 } },
  ),

  // Payments.
  fixture('/payments', paymentListResponseSchema, { payments: PAYMENTS, nextCursor: 'pay-2' }),
  fixture('/payments/:id', paymentResponseSchema, {
    payment: {
      ...PAYMENTS[0],
      evidenceNote: 'رسید کارت‌به‌کارت بررسی شد',
      resolutionNote: null,
      destination: {
        accountId: '0192d0ab-cdef-7012-8345-6789abcdef01',
        label: 'حساب اصلی',
        bankName: 'بانک ملت',
        holderName: 'نکسا',
        cardLast4: '4412',
        hasIban: true,
      },
      receiptCredit: null,
      topupCashbackPercent: null,
      gatewayInvoice: null,
      customerFee: null,
    },
  }),
  fixture('/payments/:id/receipts', paymentReceiptListResponseSchema, {
    receipts: [
      {
        id: RECEIPT_0,
        kind: 'PHOTO',
        fileUniqueId: 'AgADBAADq',
        mimeType: null,
        fileSize: 204800,
        fileName: null,
        createdAt: ago(60 * 2),
      },
    ],
  }),
  fixture('/payments/:id/refunds', refundListResponseSchema, {
    refunds: [
      {
        id: '0192f0ab-cdef-7012-8345-6789abcdef01',
        paymentId: PAYMENT_0,
        orderId: ORDER_0,
        customerId: CUSTOMER_0,
        state: 'AWAITING_EXTERNAL',
        channel: 'EXTERNAL_MANUAL',
        amountMinor: '50000',
        currency: 'IRT',
        reason: 'مشتری بخشی از حجم را نخواست',
        requestedByAdminId: ADMIN_ID,
        completedByAdminId: null,
        externalReference: null,
        completionNote: null,
        createdAt: ago(40),
        updatedAt: ago(40),
        completedAt: null,
      },
    ],
    paidMinor: '150000',
    consumedMinor: '0',
    refundableMinor: '100000',
    currency: 'IRT',
    refundable: true,
  }),
  fixture('/payments/:id/timeline', paymentTimelineResponseSchema, {
    paymentId: PAYMENT_0,
    entries: [
      {
        kind: 'PAYMENT_CREATED',
        at: ago(60 * 3),
        method: 'MANUAL_TRANSFER',
        amountMinor: '150000',
        currency: 'IRT',
      },
      { kind: 'CUSTOMER_SIGNALLED', at: ago(60 * 2 + 5) },
      { kind: 'RECEIPT_SUBMITTED', at: ago(60 * 2), receiptId: RECEIPT_0, receiptKind: 'PHOTO' },
      {
        kind: 'PAYMENT_CONFIRMED',
        at: ago(60),
        evidenceKind: 'OPERATOR_REVIEW',
        adminId: ADMIN_ID,
      },
      {
        kind: 'CUSTOMER_NOTIFIED',
        at: ago(59),
        notificationKind: 'PAYMENT_TRANSFER_RECORDED',
        deliveryState: 'DELIVERED',
        resolvedAt: ago(59),
      },
    ],
    withheld: [],
    truncated: false,
  }),

  // Compensations.
  fixture('/compensations', compensationListResponseSchema, {
    compensations: [0, 3, 5, 8].map((index) => {
      const c = CUSTOMERS[index % 6] as Json;
      return {
        refundId: uid('0192f0ab', index + 1),
        paymentId: uid('019240ab', index),
        orderId: index === 5 ? null : uid('019230ab', index),
        customerId: c['id'],
        customerTelegramUserId: c['telegramUserId'],
        customerUsername: c['username'],
        principalMinor: String(150000 + index * 20000),
        creditedMinor: String(150000 + index * 20000),
        currency: 'IRT',
        reason: index === 8 ? 'PANEL_RETIRED' : 'UNDELIVERABLE',
        state: 'COMPLETED',
        createdAt: ago(60 * 24 * (index + 1)),
        completedAt: ago(60 * 24 * (index + 1) - 1),
      };
    }),
    nextCursor: null,
  }),
];
