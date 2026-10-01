import {
  reportInfrastructureResponseSchema,
  reportOrdersResponseSchema,
  reportPaymentsResponseSchema,
  reportReferralsResponseSchema,
  reportResellersResponseSchema,
  reportServicesResponseSchema,
  reportWalletResponseSchema,
  resellerCreditResponseSchema,
  resellerHistoryResponseSchema,
  resellerListResponseSchema,
  resellerMinimumReportSchema,
  resellerPolicyResponseSchema,
  resellerPurchasePageSchema,
  referralCommissionListResponseSchema,
  referralListResponseSchema,
  tenantMediaStateSchema,
  campaignListResponseSchema,
  campaignPreviewResponseSchema,
  campaignResponseSchema,
  campaignResultsResponseSchema,
  audienceOptionsResponseSchema,
  broadcastListResponseSchema,
  broadcastRecipientListResponseSchema,
  broadcastResponseSchema,
  bulkItemListResponseSchema,
  bulkOperationListResponseSchema,
  bulkOperationResponseSchema,
  cashbackRuleListResponseSchema,
  customServiceLocationListResponseSchema,
  discountListResponseSchema,
  customServiceRuleListResponseSchema,
  productCategoryListResponseSchema,
  productListResponseSchema,
  productResponseSchema,
  resellerTierListResponseSchema,
  serviceAddonListResponseSchema,
  serviceLocationListResponseSchema,
} from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../fixture.ts';

/*
 * Page family COMMERCE-B: products, categories, extra devices, service
 * locations, custom service, discounts, campaigns, broadcasts, bulk
 * operations, referrals, resellers, reseller tiers and plans, reports.
 * The COMMERCE-B agent adds the fixtures its pages need here.
 *
 * Panels come from OPS-A's `/panels` fixture and customers from COMMERCE-A's
 * `/users`; the ids below that name one of them are copied from there.
 */

type Json = Record<string, unknown>;

const PANEL_A = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
const PANEL_B = '01a05e35-c9ad-7e93-bef3-1ed9b55292c9';

const GIB = 1024n ** 3n;

/* --------------------------------------------------------------- catalogue --- */

function category(
  id: string,
  name: string,
  emoji: string | null,
  sortOrder: number,
  productCount: number,
  over: Json = {},
): Json {
  return {
    id,
    name,
    description: null,
    emoji,
    status: 'ACTIVE',
    visibility: 'VISIBLE',
    sortOrder,
    productCount,
    createdAt: ago(60 * 24 * 300),
    updatedAt: ago(60 * 24 * 12),
    ...over,
  };
}

export const CATEGORIES: readonly Json[] = [
  category('0192c0de-0000-7000-8000-00000000ca01', 'اشتراک استاندارد', '⚡', 0, 5),
  category('0192c0de-0000-7000-8000-00000000ca02', 'اشتراک حرفه‌ای', '🚀', 1, 3),
  category('0192c0de-0000-7000-8000-00000000ca03', 'نامحدود', '♾️', 2, 1),
  category('0192c0de-0000-7000-8000-00000000ca04', 'پلن‌های قدیمی', null, 3, 2, {
    status: 'INACTIVE',
    visibility: 'HIDDEN',
  }),
];

const CATEGORY_ID = CATEGORIES.map((row) => row['id'] as string);

function product(index: number, title: string, over: Json = {}): Json {
  return {
    id: `0192c0de-0000-7000-8000-0000000001${String(index).padStart(2, '0')}`,
    title,
    description: null,
    status: 'ACTIVE',
    audience: 'EVERYONE',
    sortOrder: index,
    panelId: index % 2 === 0 ? PANEL_A : PANEL_B,
    categoryId: CATEGORY_ID[0],
    durationDays: 30,
    trafficBytes: String(50n * GIB),
    deviceLimit: 2,
    priceAmount: '149000',
    priceCurrency: 'IRT',
    displayLocations: [],
    displayFeatures: [],
    serviceLocationLabel: null,
    createdAt: ago(60 * 24 * (240 - index * 9)),
    updatedAt: ago(60 * (index * 11 + 3)),
    ...over,
  };
}

export const PRODUCTS: readonly Json[] = [
  product(1, '۳۰ گیگ — ۱ ماهه', {
    trafficBytes: String(30n * GIB),
    priceAmount: '89000',
    description: 'مناسب استفادهٔ روزمره روی یک یا دو دستگاه.',
    displayLocations: ['آلمان', 'هلند'],
    displayFeatures: ['بدون قطعی', 'پشتیبانی ۲۴ ساعته'],
    serviceLocationLabel: 'Frankfurt',
  }),
  product(2, '۶۰ گیگ — ۱ ماهه', { trafficBytes: String(60n * GIB), priceAmount: '149000' }),
  product(3, '۱۰۰ گیگ — ۱ ماهه', {
    trafficBytes: String(100n * GIB),
    priceAmount: '219000',
    categoryId: CATEGORY_ID[1],
    deviceLimit: 3,
  }),
  product(4, '۲۰۰ گیگ — ۳ ماهه', {
    trafficBytes: String(200n * GIB),
    durationDays: 90,
    priceAmount: '549000',
    categoryId: CATEGORY_ID[1],
  }),
  product(5, 'نامحدود — ۱ ماهه', {
    trafficBytes: '0',
    priceAmount: '390000',
    categoryId: CATEGORY_ID[2],
  }),
  product(6, 'نمایندگی — ۵۰۰ گیگ', {
    trafficBytes: String(500n * GIB),
    durationDays: 180,
    priceAmount: '1290000',
    audience: 'RESELLERS_ONLY',
    categoryId: CATEGORY_ID[1],
  }),
  product(7, 'پلن هدیه — ۱۰ گیگ', {
    trafficBytes: String(10n * GIB),
    durationDays: 7,
    priceAmount: '19000',
    audience: 'HIDDEN',
  }),
  product(8, '۱۵ گیگ — ۱ ماهه (قدیمی)', {
    trafficBytes: String(15n * GIB),
    priceAmount: '59000',
    categoryId: CATEGORY_ID[3],
  }),
  product(9, 'پلن آزمایشی بدون قیمت', {
    status: 'INACTIVE',
    priceAmount: null,
    priceCurrency: null,
    categoryId: null,
    panelId: null,
  }),
];

/* ------------------------------------------------ extra devices, locations --- */

function addon(index: number, title: string, over: Json = {}): Json {
  return {
    id: `0192c0de-0000-7000-8000-0000000002${String(index).padStart(2, '0')}`,
    kind: 'ADD_DEVICES',
    title,
    status: 'ACTIVE',
    sortOrder: index,
    trafficBytes: null,
    durationDays: null,
    maxQuantity: 3,
    panelId: null,
    productId: null,
    version: 1,
    priceAmount: '50000',
    priceCurrency: 'IRT',
    createdAt: ago(60 * 24 * 60),
    updatedAt: ago(60 * 24 * (index + 1)),
    ...over,
  };
}

const ADDONS: readonly Json[] = [
  addon(1, 'کاربر اضافه — عمومی'),
  addon(2, 'کاربر اضافه — فرانکفورت', { panelId: PANEL_A, priceAmount: '40000', maxQuantity: 5 }),
  addon(3, 'کاربر اضافه — پلن حرفه‌ای', {
    productId: PRODUCTS[2]?.['id'],
    priceAmount: '30000',
    status: 'INACTIVE',
  }),
];

function serviceLocation(index: number, label: string, key: string, over: Json = {}): Json {
  return {
    id: `0192c0de-0000-7000-8000-0000000003${String(index).padStart(2, '0')}`,
    panelId: PANEL_A,
    productId: null,
    locationKey: key,
    label,
    initial: false,
    enabled: true,
    priceAmount: '30000',
    priceCurrency: 'IRT',
    cooldownHours: 24,
    maxChanges: 2,
    periodDays: 30,
    sortOrder: index,
    version: 1,
    createdAt: ago(60 * 24 * 90),
    updatedAt: ago(60 * 24 * index),
    ...over,
  };
}

export const SERVICE_LOCATIONS: readonly Json[] = [
  serviceLocation(1, '🇩🇪 آلمان', 'de-1', {
    initial: true,
    enabled: false,
    priceAmount: null,
    priceCurrency: null,
    cooldownHours: null,
    maxChanges: null,
    periodDays: null,
  }),
  serviceLocation(2, '🇳🇱 هلند', 'nl-1', { priceAmount: '0' }),
  serviceLocation(3, '🇫🇮 فنلاند', 'fi-1'),
  serviceLocation(4, '🇹🇷 ترکیه', 'tr-1', { panelId: PANEL_B, maxChanges: null, periodDays: null }),
];

/* ---------------------------------------------------------- custom service --- */

const TIERS: readonly Json[] = [
  tier(1, 'برنزی', 'LIST_PRICE', null, '0', 4),
  tier(2, 'نقره‌ای', 'PERCENTAGE_DISCOUNT', 10, '0', 7),
  tier(3, 'طلایی', 'PERCENTAGE_DISCOUNT', 20, '0', 2),
];

function tier(
  index: number,
  name: string,
  pricingMode: string,
  discountPercentage: number | null,
  credit: string,
  resellerCount: number,
): Json {
  return {
    id: `0192c0de-0000-7000-8000-0000000004${String(index).padStart(2, '0')}`,
    name,
    pricingMode,
    discountPercentage,
    creditLimit: { amount: credit, currency: 'IRT' },
    grants:
      index === 1
        ? []
        : [
            { kind: 'OPERATION', subject: null },
            { kind: 'PRODUCT', subject: null },
            { kind: 'PANEL', subject: index === 3 ? null : PANEL_A },
            { kind: 'BOT', subject: null },
          ],
    resellerCount,
    monthlyMinimum: index === 3 ? { amount: '20000000', currency: 'IRT' } : null,
    createdAt: ago(60 * 24 * 200),
    updatedAt: ago(60 * 24 * 20),
  };
}

function customRule(index: number, over: Json): Json {
  return {
    id: `0192c0de-0000-7000-8000-0000000005${String(index).padStart(2, '0')}`,
    dimension: 'VOLUME',
    label: null,
    minimum: '10',
    maximum: '500',
    unitPriceAmount: '2500',
    currency: 'IRT',
    customerId: null,
    resellerTierId: null,
    panelId: null,
    enabled: true,
    createdAt: ago(60 * 24 * 30),
    updatedAt: ago(60 * 24 * 3),
    ...over,
  };
}

const CUSTOM_RULES: readonly Json[] = [
  customRule(1, { label: 'حجم عمومی' }),
  customRule(2, {
    dimension: 'TIME',
    label: 'روز عمومی',
    minimum: '1',
    maximum: '90',
    unitPriceAmount: '900',
  }),
  customRule(3, {
    label: 'حجم نمایندگان طلایی',
    resellerTierId: TIERS[2]?.['id'],
    unitPriceAmount: '1800',
    panelId: PANEL_A,
  }),
  customRule(4, { label: 'حجم عمده', minimum: '100.5', maximum: '2000', enabled: false }),
];

/* ------------------------------------------------------ discounts, cashback --- */

function discount(index: number, label: string, over: Json): Json {
  return {
    id: `0192c0de-0000-7000-8000-0000000006${String(index).padStart(2, '0')}`,
    kind: 'CODE',
    code: null,
    label,
    type: 'PERCENTAGE',
    value: '10',
    currency: null,
    appliesTo: ['NEW_SERVICE'],
    productId: null,
    categoryId: null,
    customerId: null,
    firstPurchaseOnly: false,
    minimumSubtotalAmount: null,
    startsAt: null,
    endsAt: null,
    totalRedemptionsLimit: null,
    perCustomerLimit: null,
    priority: 10,
    stackable: false,
    status: 'ACTIVE',
    liveRedemptions: 0,
    createdAt: ago(60 * 24 * (40 - index)),
    updatedAt: ago(60 * 24 * index),
    ...over,
  };
}

const DISCOUNTS: readonly Json[] = [
  discount(1, 'تخفیف مهر', {
    code: 'MEHR20',
    value: '20',
    appliesTo: ['NEW_SERVICE', 'RENEW'],
    categoryId: CATEGORY_ID[1],
    startsAt: ago(60 * 24 * 7),
    endsAt: ago(-60 * 24 * 23),
    totalRedemptionsLimit: 500,
    perCustomerLimit: 1,
    liveRedemptions: 312,
  }),
  discount(2, 'خوش‌آمد', {
    code: 'WELCOME10',
    firstPurchaseOnly: true,
    liveRedemptions: 1840,
    perCustomerLimit: 1,
  }),
  discount(3, 'برگشت مشتری', {
    code: 'BACK15',
    value: '15',
    productId: PRODUCTS[1]?.['id'],
    totalRedemptionsLimit: 300,
    liveRedemptions: 96,
    stackable: true,
  }),
  discount(4, 'نوروز', {
    code: 'NOWRUZ',
    type: 'FIXED_AMOUNT',
    value: '30000',
    currency: 'IRT',
    appliesTo: ['NEW_SERVICE', 'RENEW', 'ADD_TRAFFIC'],
    minimumSubtotalAmount: '100000',
    totalRedemptionsLimit: 1000,
    liveRedemptions: 1000,
    status: 'INACTIVE',
    startsAt: ago(60 * 24 * 190),
    endsAt: ago(60 * 24 * 170),
  }),
  discount(5, 'تمدید خودکار پاییز', {
    kind: 'AUTOMATIC',
    value: '5',
    appliesTo: ['RENEW'],
    priority: 5,
    liveRedemptions: 402,
  }),
];

const CASHBACK_RULES: readonly Json[] = [
  {
    id: '0192c0de-0000-7000-8000-000000000701',
    label: 'وفاداری ۵٪',
    percent: 5,
    appliesTo: ['NEW_SERVICE', 'RENEW'],
    productId: null,
    categoryId: null,
    startsAt: null,
    endsAt: null,
    status: 'ACTIVE',
    createdAt: ago(60 * 24 * 60),
    updatedAt: ago(60 * 24 * 4),
  },
  {
    id: '0192c0de-0000-7000-8000-000000000702',
    label: 'کش‌بک پلن حرفه‌ای',
    percent: 8,
    appliesTo: ['NEW_SERVICE'],
    productId: null,
    categoryId: CATEGORY_ID[1],
    startsAt: ago(60 * 24 * 3),
    endsAt: ago(-60 * 24 * 27),
    status: 'INACTIVE',
    createdAt: ago(60 * 24 * 10),
    updatedAt: ago(60 * 24 * 1),
  },
];

/* ------------------------------------------- broadcasts and bulk operations --- */

const HASH = 'a'.repeat(64);

const EMPTY_COUNTS = {
  total: 0,
  pending: 0,
  sending: 0,
  sent: 0,
  unconfirmed: 0,
  failed: 0,
  unreachable: 0,
  skipped: 0,
  cancelled: 0,
  pinned: 0,
  pinFailed: 0,
};

function broadcast(index: number, title: string, over: Json = {}): Json {
  return {
    id: `0192c0de-0000-7000-8000-0000000008${String(index).padStart(2, '0')}`,
    title,
    state: 'DRAFT',
    pauseReason: null,
    contentKind: 'TEXT',
    body: 'سلام {firstName} 👋\nتخفیف ۲۰٪ پاییزه برای تمدید سرویس شما فعال شد.\nکد: MEHR20',
    buttons: [{ label: 'خرید با تخفیف', url: 'https://t.me/nexa_bot?start=mehr' }],
    media: null,
    purpose: 'MARKETING',
    source: null,
    sourceVerifiedAt: null,
    pin: false,
    frozenAudienceId: null,
    audience: { version: 1, customerStatus: 'ACTIVE', purchase: 'PURCHASED' },
    audienceHash: HASH,
    audienceAsOf: null,
    recipientCount: null,
    fingerprint: null,
    scheduledAt: null,
    counts: EMPTY_COUNTS,
    progressPercent: null,
    version: 3,
    createdBy: { id: 'x', username: 'owner' },
    launchedBy: null,
    createdAt: ago(60 * 24 * index),
    launchedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    ...over,
  };
}

const SENDING_BROADCAST = broadcast(2, 'اطلاع‌رسانی به‌روزرسانی سرورها', {
  state: 'SENDING',
  purpose: 'SERVICE_ANNOUNCEMENT',
  pin: true,
  recipientCount: 1240,
  fingerprint: 'b'.repeat(32),
  audienceAsOf: ago(90),
  progressPercent: 62,
  launchedBy: { id: 'x', username: 'owner' },
  launchedAt: ago(80),
  startedAt: ago(80),
  counts: {
    ...EMPTY_COUNTS,
    total: 1240,
    pending: 420,
    sending: 12,
    sent: 760,
    failed: 21,
    unreachable: 18,
    unconfirmed: 9,
    pinned: 740,
    pinFailed: 20,
  },
});

export const BROADCASTS: readonly Json[] = [
  broadcast(1, 'تخفیف پاییزه — مشتریان فعال'),
  SENDING_BROADCAST,
  broadcast(3, 'یادآوری تمدید', {
    state: 'COMPLETED',
    recipientCount: 380,
    progressPercent: 100,
    counts: { ...EMPTY_COUNTS, total: 380, sent: 371, unreachable: 9 },
    completedAt: ago(60 * 24 * 2),
  }),
  broadcast(4, 'معرفی پلن نامحدود', {
    state: 'SCHEDULED',
    contentKind: 'PHOTO',
    recipientCount: 2100,
    scheduledAt: ago(-60 * 20),
    progressPercent: 0,
  }),
  broadcast(5, 'پیام تست کانال', { state: 'CANCELLED', contentKind: 'FORWARD', body: '' }),
];

const RECIPIENT_STATES = ['SENT', 'SENT', 'PENDING', 'FAILED', 'SENT', 'UNREACHABLE', 'SENT'];

const RECIPIENTS: readonly Json[] = RECIPIENT_STATES.map((state, index) => ({
  customerId: `019210ab-cdef-7012-8345-${String(6789 + index).padStart(4, '0')}abcdef01`,
  firstName: ['علی', 'مریم', 'سارا', 'حامد', 'مهدی', 'نگار', 'زهرا'][index] ?? null,
  username: `user_${String(index)}`,
  state,
  attempts: state === 'PENDING' ? 0 : state === 'FAILED' ? 3 : 1,
  errorCode: state === 'FAILED' ? 'TELEGRAM_429' : state === 'UNREACHABLE' ? 'BOT_BLOCKED' : null,
  resolvedAt: state === 'PENDING' ? null : ago(70 - index),
  pinState: state === 'SENT' ? 'PINNED' : null,
  pinErrorCode: null,
}));

function bulk(index: number, over: Json = {}): Json {
  return {
    id: `0192c0de-0000-7000-8000-0000000009${String(index).padStart(2, '0')}`,
    kind: 'WALLET_CREDIT',
    state: 'COMPLETED',
    amount: { amountMinor: '50000', currency: 'IRT' },
    trafficBytes: null,
    durationDays: null,
    notify: true,
    note: 'هدیهٔ نوروزی',
    audience: { version: 1, customerStatus: 'ACTIVE', purchase: 'PURCHASED' },
    audienceHash: HASH,
    audienceAsOf: ago(60 * 24 * index + 5),
    notBefore: null,
    frozenAudienceId: null,
    itemCount: 320,
    fingerprint: 'b'.repeat(32),
    totalLiability: { amountMinor: '16000000', currency: 'IRT' },
    creditedTotal: { amountMinor: '16000000', currency: 'IRT' },
    counts: {
      total: 320,
      pending: 0,
      credited: 320,
      planned: 0,
      awaitingReconciliation: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      notified: 318,
      notificationQueued: 2,
    },
    progressPercent: 100,
    createdBy: { id: 'x', username: 'owner' },
    createdAt: ago(60 * 24 * index),
    pausedAt: null,
    completedAt: ago(60 * 24 * index - 30),
    cancelledAt: null,
    ...over,
  };
}

const RUNNING_BULK = bulk(1, {
  kind: 'SERVICE_TRAFFIC',
  state: 'RUNNING',
  amount: null,
  trafficBytes: String(10n * GIB),
  note: 'جبران قطعی سرور فرانکفورت',
  itemCount: 540,
  totalLiability: null,
  creditedTotal: null,
  counts: {
    total: 540,
    pending: 210,
    credited: 0,
    planned: 4,
    awaitingReconciliation: 1,
    succeeded: 318,
    failed: 3,
    skipped: 5,
    cancelled: 0,
    notified: 300,
    notificationQueued: 18,
  },
  progressPercent: 61,
  completedAt: null,
});

const BULK_OPERATIONS: readonly Json[] = [
  RUNNING_BULK,
  bulk(3),
  bulk(9, {
    kind: 'SERVICE_TIME',
    amount: null,
    durationDays: 7,
    totalLiability: null,
    creditedTotal: null,
    state: 'CANCELLED',
    progressPercent: 40,
    itemCount: 100,
  }),
];

const BULK_ITEMS: readonly Json[] = RECIPIENTS.slice(0, 6).map((recipient, index) => ({
  id: `0192c0de-0000-7000-8000-00000000a${String(index).padStart(3, '0')}`,
  customerId: recipient['customerId'],
  firstName: recipient['firstName'],
  username: recipient['username'],
  serviceId: `0192c0de-0000-7000-8000-00000000b${String(index).padStart(3, '0')}`,
  serviceLabel: `nx${String(4812 + index * 37)}`,
  state: ['SUCCEEDED', 'SUCCEEDED', 'PENDING', 'FAILED', 'SKIPPED', 'PLANNED'][index],
  skipReason: index === 4 ? 'UNLIMITED' : null,
  operationState: index === 5 ? 'UNKNOWN' : null,
  failureKind: index === 3 ? 'PROVIDER_TIMEOUT' : null,
  notified: index < 2,
  notificationState: index < 2 ? 'DELIVERED' : index === 2 ? null : 'PENDING',
  processedAt: index === 2 ? null : ago(30 - index),
}));

/* --------------------------------------------------------------- campaigns --- */

const PRESENTATION = { timezone: 'Asia/Tehran', calendar: 'jalali' };

function campaign(index: number, name: string, over: Json = {}): Json {
  return {
    id: `0192c0de-0000-7000-8000-0000000010${String(index).padStart(2, '0')}`,
    name,
    description: '',
    state: 'DRAFT',
    startsAt: ago(-60 * 24 * 4),
    endsAt: ago(-60 * 24 * 14),
    startLocal: { date: '1405-06-19', time: '10:00' },
    endLocal: { date: '1405-06-29', time: '23:59' },
    audienceConfirmedCount: null,
    actionKinds: ['DISCOUNT', 'WALLET_GIFT'],
    scheduledAt: null,
    startedAt: null,
    pausedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: ago(60 * 24 * (index + 1)),
    updatedAt: ago(60 * index),
    ...over,
  };
}

const CAMPAIGNS: readonly Json[] = [
  campaign(1, 'جشنواره پاییز', {
    description: 'تخفیف ۲۰٪ و هدیهٔ کیف پول برای مشتریان فعال.',
  }),
  campaign(2, 'بازگشت مشتریان غیرفعال', {
    state: 'ACTIVE',
    actionKinds: ['DISCOUNT', 'ANNOUNCEMENT'],
    audienceConfirmedCount: 2140,
    startLocal: { date: '1405-06-10', time: '09:00' },
    scheduledAt: ago(60 * 24 * 6),
    startedAt: ago(60 * 24 * 5),
  }),
  campaign(3, 'یلدا', {
    state: 'SCHEDULED',
    actionKinds: ['CASHBACK', 'TRAFFIC_GIFT'],
    audienceConfirmedCount: 860,
    scheduledAt: ago(60 * 2),
  }),
  campaign(4, 'نوروز ۱۴۰۵', {
    state: 'COMPLETED',
    actionKinds: ['DISCOUNT'],
    audienceConfirmedCount: 5400,
    completedAt: ago(60 * 24 * 150),
  }),
];

const DISCOUNT_TERMS = {
  kind: 'CODE',
  code: 'MEHR20',
  type: 'PERCENTAGE',
  value: '20',
  currency: null,
  appliesTo: ['NEW_SERVICE', 'RENEW'],
  productId: null,
  categoryId: null,
  firstPurchaseOnly: false,
  minimumSubtotalAmount: null,
  totalRedemptionsLimit: 500,
  perCustomerLimit: 1,
  priority: 10,
  stackable: false,
};

function action(kind: string, terms: unknown, over: Json = {}): Json {
  return {
    kind,
    state: 'PENDING',
    terms,
    ruleStatus: null,
    discountId: null,
    cashbackRuleId: null,
    broadcastId: null,
    bulkOperationId: null,
    frozenAudienceId: null,
    failureCode: null,
    launchedAt: null,
    ...over,
  };
}

function campaignDetail(row: Json, actions: readonly Json[]): Json {
  return {
    campaign: {
      ...row,
      audience: { version: 1, customerStatus: 'ACTIVE', purchase: 'PURCHASED' },
      audienceHash: HASH,
      audienceFingerprint: null,
      actions,
    },
    presentation: PRESENTATION,
  };
}

/* --------------------------------------------------------------- referrals --- */

function party(index: number, name: string | null): Json {
  return {
    customerId: `019210ab-cdef-7012-8345-${String(6789 + index).padStart(4, '0')}abcdef01`,
    telegramUserId: String(5551234567 + index * 7919),
    displayName: name,
  };
}

const REFERRERS = [party(0, 'علی رضایی'), party(1, 'مریم اکبری'), party(5, 'نگار موسوی')];
const REFEREES = [
  party(2, 'سارا شریفی'),
  party(3, null),
  party(4, 'مهدی قاسمی'),
  party(6, 'زهرا مرادی'),
  party(7, null),
];

const REFERRALS: readonly Json[] = REFEREES.map((referee, index) => ({
  id: `0192c0de-0000-7000-8000-0000000011${String(index).padStart(2, '0')}`,
  referrer: REFERRERS[index % REFERRERS.length],
  referee,
  trigger: index % 2 === 0 ? 'ON_FIRST_PAID_ORDER' : 'ON_EVERY_PAID_ORDER',
  createdAt: ago(60 * 24 * (index * 3 + 1)),
}));

const COMMISSION_STATES = ['EARNED', 'EARNED', 'PENDING', 'VOID', 'EARNED'];

const COMMISSIONS: readonly Json[] = COMMISSION_STATES.map((state, index) => ({
  id: `0192c0de-0000-7000-8000-0000000012${String(index).padStart(2, '0')}`,
  referralId: REFERRALS[index]?.['id'],
  orderId: `0192c0de-0000-7000-8000-0000000013${String(index).padStart(2, '0')}`,
  referrer: REFERRERS[index % REFERRERS.length],
  referee: REFEREES[index],
  scope: index % 2 === 0 ? 'FIRST_PAID_ORDER' : 'EVERY_PAID_ORDER',
  percent: 10,
  basisAmount: String(149000 * (index + 1)),
  promisedAmount: String(14900 * (index + 1)),
  currency: 'IRT',
  state,
  earnedAmount: state === 'EARNED' ? String(14900 * (index + 1)) : null,
  reversedAmount: index === 4 ? '20000' : '0',
  unrecoveredAmount: index === 4 ? '5000' : '0',
  createdAt: ago(60 * 24 * (index * 2 + 1)),
  earnedAt: state === 'EARNED' ? ago(60 * 24 * index * 2) : null,
  voidedAt: state === 'VOID' ? ago(60 * 24 * index * 2) : null,
}));

/* --------------------------------------------------------------- resellers --- */

const IRT = (amount: string): Json => ({ amount, currency: 'IRT' });

function resellerRow(index: number, name: string | null, tierIndex: number, over: Json = {}): Json {
  const tier = TIERS[tierIndex] ?? {};
  return {
    customerId: `019210ab-cdef-7012-8345-${String(6789 + index).padStart(4, '0')}abcdef01`,
    telegramUserId: String(5551234567 + index * 7919),
    displayName: name,
    tier: { id: tier['id'], name: tier['name'] },
    status: 'ACTIVE',
    pricingMode: 'TIER',
    discountPercentage: null,
    creditLimit: null,
    effectiveCreditLimit: tier['creditLimit'],
    createdAt: ago(60 * 24 * (120 - index * 7)),
    updatedAt: ago(60 * 24 * index),
    ...over,
  };
}

export const RESELLERS: readonly Json[] = [
  resellerRow(3, 'حامد کریمی', 2, { pricingMode: 'PERCENTAGE_DISCOUNT', discountPercentage: 25 }),
  resellerRow(8, 'الهام احمدی', 1),
  resellerRow(9, null, 1),
  resellerRow(11, 'رضا نادری', 0, { status: 'SUSPENDED' }),
  resellerRow(12, 'بهنام زارعی', 2),
];

const FIRST_RESELLER = RESELLERS[0]?.['customerId'] as string;

const RESELLER_POLICY: Json = {
  customerId: FIRST_RESELLER,
  status: 'ACTIVE',
  tier: { id: TIERS[2]?.['id'], name: TIERS[2]?.['name'] },
  dimensions: [
    {
      dimension: 'OPERATION',
      source: 'TIER',
      tierGrants: [{ kind: 'OPERATION', subject: null }],
      overrideGrants: null,
      effectiveGrants: [{ kind: 'OPERATION', subject: null }],
    },
    {
      dimension: 'CATALOGUE',
      source: 'RESELLER',
      tierGrants: [{ kind: 'PRODUCT', subject: null }],
      overrideGrants: [{ kind: 'PRODUCT', subject: PRODUCTS[2]?.['id'] }],
      effectiveGrants: [{ kind: 'PRODUCT', subject: PRODUCTS[2]?.['id'] }],
    },
    {
      dimension: 'PANEL',
      source: 'TIER',
      tierGrants: [{ kind: 'PANEL', subject: PANEL_A }],
      overrideGrants: null,
      effectiveGrants: [{ kind: 'PANEL', subject: PANEL_A }],
    },
    {
      dimension: 'BOT',
      source: 'TIER',
      tierGrants: [{ kind: 'BOT', subject: null }],
      overrideGrants: null,
      effectiveGrants: [{ kind: 'BOT', subject: null }],
    },
  ],
  pricing: {
    tierMode: 'PERCENTAGE_DISCOUNT',
    tierPercent: 20,
    overrideMode: 'PERCENTAGE_DISCOUNT',
    overridePercent: 25,
    layer: 'OVERRIDE',
    percent: 25,
  },
  monthlyMinimum: {
    tier: IRT('20000000'),
    own: null,
    effective: IRT('20000000'),
    source: 'TIER',
  },
  botBasis: 'ANY_BOT',
  products: [
    {
      productId: PRODUCTS[2]?.['id'],
      title: PRODUCTS[2]?.['title'],
      status: 'ACTIVE',
      categoryId: PRODUCTS[2]?.['categoryId'],
      panelId: PANEL_A,
      allowed: true,
      refusedDimension: null,
    },
    {
      productId: PRODUCTS[1]?.['id'],
      title: PRODUCTS[1]?.['title'],
      status: 'ACTIVE',
      categoryId: PRODUCTS[1]?.['categoryId'],
      panelId: PANEL_A,
      allowed: false,
      refusedDimension: 'CATALOGUE',
    },
  ],
  productsComplete: true,
};

function minimumRow(reseller: Json, over: Json): Json {
  return {
    customerId: reseller['customerId'],
    telegramUserId: reseller['telegramUserId'],
    displayName: reseller['displayName'],
    tier: reseller['tier'],
    status: reseller['status'],
    minimum: IRT('20000000'),
    source: 'TIER',
    achieved: IRT('12400000'),
    remaining: IRT('7600000'),
    progressBasisPoints: 6_200,
    state: 'BELOW',
    ...over,
  };
}

/* ----------------------------------------------------------------- reports --- */

/*
 * The report tabs the dashboard does not already answer (DASH owns summary, trend,
 * products and failures). One period serves them all; the pages only print it.
 */
const REPORT_PERIOD = {
  range: 'THIS_MONTH',
  timezone: 'Asia/Tehran',
  calendar: 'jalali',
  granularity: 'DAY',
  current: {
    start: '2026-08-22T20:30:00.000Z',
    end: '2026-09-22T20:30:00.000Z',
    effectiveEnd: '2026-09-06T08:00:00.000Z',
    startLocal: '1405/06/01',
    endLocalInclusive: '1405/06/31',
  },
  previous: {
    start: '2026-07-22T20:30:00.000Z',
    end: '2026-08-22T20:30:00.000Z',
    effectiveEnd: '2026-08-06T08:00:00.000Z',
    startLocal: '1405/05/01',
    endLocalInclusive: '1405/05/31',
  },
  lengthsDiffer: false,
  generatedAt: ago(0),
};

const cmp = (current: number, previous: number): Json => ({ current, previous });
const irtCmp = (current: string, previous: string): Json[] => [
  { currency: 'IRT', current, previous },
];

function payment(method: string, provider: string | null, kind: string, over: Json): Json {
  return {
    method,
    provider,
    kind,
    attempts: 0,
    confirmed: 0,
    failed: 0,
    cancelled: 0,
    expired: 0,
    pending: 0,
    unknown: 0,
    successRateBasisPoints: null,
    confirmedAmount: [],
    ...over,
  };
}

const PAYMENT_ROWS: readonly Json[] = [
  payment('GATEWAY', 'tonpays', 'ORDER', {
    attempts: 212,
    confirmed: 184,
    failed: 9,
    expired: 14,
    pending: 5,
    successRateBasisPoints: 8_679,
    confirmedAmount: [{ currency: 'IRT', amount: '27416000' }],
  }),
  payment('MANUAL_TRANSFER', null, 'ORDER', {
    attempts: 96,
    confirmed: 88,
    cancelled: 5,
    pending: 3,
    successRateBasisPoints: 9_167,
    confirmedAmount: [{ currency: 'IRT', amount: '13112000' }],
  }),
  payment('WALLET', null, 'ORDER', {
    attempts: 141,
    confirmed: 141,
    successRateBasisPoints: 10_000,
    confirmedAmount: [{ currency: 'IRT', amount: '19740000' }],
  }),
  payment('GATEWAY', 'tonpays', 'TOPUP', {
    attempts: 41,
    confirmed: 37,
    expired: 4,
    successRateBasisPoints: 9_024,
    confirmedAmount: [{ currency: 'IRT', amount: '9250000' }],
  }),
];

function infra(over: Json): Json {
  return {
    servicesCreated: 0,
    activeServices: 0,
    trafficSoldBytes: '0',
    unlimitedTrafficLines: 0,
    provisioningFailures: 0,
    ...over,
  };
}

export const COMMERCE_B: readonly ShotFixture[] = [
  fixture('/reports/orders', reportOrdersResponseSchema, {
    period: REPORT_PERIOD,
    rows: PRODUCTS.slice(0, 6).map((row, index) => ({
      orderId: `0192c0de-0000-7000-8000-0000000016${String(index).padStart(2, '0')}`,
      settledAt: ago(60 * (index * 7 + 1)),
      purpose: index % 3 === 1 ? 'RENEW' : 'NEW_SERVICE',
      title: row['title'],
      categoryName: null,
      subtotal: row['priceAmount'] ?? '0',
      discount: index === 0 ? '17800' : '0',
      total: String(
        BigInt((row['priceAmount'] as string | null) ?? '0') - (index === 0 ? 17800n : 0n),
      ),
      currency: 'IRT',
      paymentMethod: index % 2 === 0 ? 'GATEWAY' : 'WALLET',
      paymentProvider: index % 2 === 0 ? 'tonpays' : null,
      customerId: `019210ab-cdef-7012-8345-${String(6789 + index).padStart(4, '0')}abcdef01`,
    })),
    nextCursor: 'cursor-orders-2',
  }),
  fixture('/reports/services', reportServicesResponseSchema, {
    period: REPORT_PERIOD,
    newServices: cmp(186, 161),
    newTrialServices: cmp(74, 90),
    activeServices: 412,
    states: [
      { state: 'ACTIVE', count: 412 },
      { state: 'SUSPENDED', count: 18 },
      { state: 'EXPIRED', count: 96 },
    ],
    operations: [
      { purpose: 'NEW_SERVICE', orders: cmp(186, 161), revenue: irtCmp('33210000', '28400000') },
      { purpose: 'RENEW', orders: cmp(143, 150), revenue: irtCmp('21860000', '22950000') },
      { purpose: 'ADD_TRAFFIC', orders: cmp(61, 44), revenue: irtCmp('3050000', '2200000') },
      { purpose: 'ADD_TIME', orders: cmp(12, 9), revenue: irtCmp('540000', '405000') },
    ],
    trafficSoldBytes: String(18_400n * GIB),
    unlimitedTrafficLines: 22,
  }),
  fixture('/reports/payments', reportPaymentsResponseSchema, {
    period: REPORT_PERIOD,
    rows: PAYMENT_ROWS,
    totals: payment('GATEWAY', null, 'ORDER', {
      attempts: 490,
      confirmed: 450,
      failed: 9,
      cancelled: 5,
      expired: 18,
      pending: 8,
      successRateBasisPoints: 9_184,
      confirmedAmount: [{ currency: 'IRT', amount: '69518000' }],
    }),
  }),
  fixture('/reports/wallet', reportWalletResponseSchema, {
    period: REPORT_PERIOD,
    reasons: [
      {
        reason: 'TOPUP_GATEWAY',
        direction: 'CREDIT',
        group: 'TOPUP',
        currency: 'IRT',
        entries: 37,
        amount: '9250000',
      },
      {
        reason: 'PURCHASE',
        direction: 'DEBIT',
        group: 'SPENDING',
        currency: 'IRT',
        entries: 141,
        amount: '19740000',
      },
      {
        reason: 'CASHBACK_PURCHASE',
        direction: 'CREDIT',
        group: 'CASHBACK',
        currency: 'IRT',
        entries: 64,
        amount: '480000',
      },
    ],
    groups: [
      { group: 'TOPUP', currency: 'IRT', entries: 37, amount: '9250000' },
      { group: 'SPENDING', currency: 'IRT', entries: 141, amount: '19740000' },
      { group: 'CASHBACK', currency: 'IRT', entries: 64, amount: '480000' },
    ],
    balances: [{ currency: 'IRT', amount: '41200000' }],
  }),
  fixture('/reports/infrastructure', reportInfrastructureResponseSchema, {
    period: REPORT_PERIOD,
    panels: [
      {
        panelId: PANEL_A,
        panelName: 'Frankfurt A',
        providerType: 'marzban',
        ...infra({
          servicesCreated: 120,
          activeServices: 212,
          trafficSoldBytes: String(11_200n * GIB),
          unlimitedTrafficLines: 14,
          provisioningFailures: 2,
        }),
      },
      {
        panelId: PANEL_B,
        panelName: 'Frankfurt B',
        providerType: 'marzban',
        ...infra({
          servicesCreated: 66,
          activeServices: 200,
          trafficSoldBytes: String(7_200n * GIB),
          unlimitedTrafficLines: 8,
        }),
      },
    ],
    providers: [
      {
        providerType: 'marzban',
        ...infra({
          servicesCreated: 186,
          activeServices: 412,
          trafficSoldBytes: String(18_400n * GIB),
          unlimitedTrafficLines: 22,
          provisioningFailures: 2,
        }),
      },
    ],
    truncated: false,
    locationSupported: false,
  }),
  fixture('/reports/resellers', reportResellersResponseSchema, {
    period: REPORT_PERIOD,
    rows: RESELLERS.slice(0, 3).map((row, index) => ({
      resellerCustomerId: row['customerId'],
      tierName: (row['tier'] as Json)['name'],
      status: row['status'],
      orders: 48 - index * 13,
      sales: [{ currency: 'IRT', amount: String(7_860_000 - index * 2_100_000) }],
      services: 40 - index * 11,
      // Reseller credit was removed (owner decision, 2026-10-01): no limit, a legacy debt.
      creditLimit: null,
      creditInUse: { amountMinor: String(3_200_000 - index * 1_000_000), currency: 'IRT' },
    })),
    truncated: false,
  }),
  fixture('/reports/referrals', reportReferralsResponseSchema, {
    period: REPORT_PERIOD,
    signups: cmp(64, 51),
    convertedBuyers: 23,
    conversionBasisPoints: 3_594,
    signupGifts: [{ currency: 'IRT', amount: '640000', entries: 64 }],
    commissions: [{ currency: 'IRT', amount: '342700', entries: 23 }],
    commissionReversals: [],
    referredSales: 31,
    referredRevenue: [{ currency: 'IRT', amount: '4930000' }],
    topReferrers: {
      by: 'SIGNUPS',
      rankingCurrency: 'IRT',
      page: 1,
      limit: 10,
      totalRows: 3,
      rows: REFERRERS.map((referrer, index) => ({
        rank: index + 1,
        referrerId: referrer['customerId'],
        signups: 28 - index * 9,
        convertedBuyers: 11 - index * 4,
        revenue: [{ currency: 'IRT', amount: String(2_100_000 - index * 600_000) }],
        commission: [{ currency: 'IRT', amount: String(149_000 - index * 45_000) }],
      })),
    },
  }),
  fixture('/resellers', resellerListResponseSchema, { resellers: RESELLERS, nextCursor: null }),
  fixture('/resellers/:id/credit', resellerCreditResponseSchema, {
    credit: {
      customerId: FIRST_RESELLER,
      status: 'ACTIVE',
      effectiveLimit: IRT('0'),
      limitSource: 'TIER',
      sellingCurrency: 'IRT',
      credit: 'NO_LIMIT',
      // A legacy debt, from before the owner removed reseller credit (2026-10-01).
      balance: IRT('-3200000'),
      allowance: IRT('0'),
      creditInUse: IRT('3200000'),
      availableToSpend: IRT('-3200000'),
      overLimitBy: IRT('3200000'),
    },
  }),
  fixture('/resellers/:id/purchases', resellerPurchasePageSchema, {
    purchases: [0, 1, 2].map((index) => ({
      orderId: `0192c0de-0000-7000-8000-0000000014${String(index).padStart(2, '0')}`,
      orderState: index === 2 ? 'AWAITING_PAYMENT' : 'PAID',
      purpose: index === 1 ? 'RENEW' : 'NEW_SERVICE',
      confirmedAt: ago(60 * 24 * (index + 1)),
      tierName: TIERS[2]?.['name'],
      layer: 'OVERRIDE',
      percent: 25,
      listAmount: '219000',
      costAmount: '164250',
      promotionAmount: '0',
      saleAmount: '164250',
      currency: 'IRT',
    })),
    nextCursor: null,
  }),
  fixture('/resellers/:id/history', resellerHistoryResponseSchema, {
    entries: [
      {
        id: '0192c0de-0000-7000-8000-000000001501',
        action: 'reseller.update',
        actorType: 'WEB_ADMIN',
        actorLabel: 'owner',
        surface: 'WEB',
        result: 'SUCCESS',
        occurredAt: ago(60 * 24 * 3),
        before: { pricingMode: 'TIER', discountPercentage: null },
        after: { pricingMode: 'PERCENTAGE_DISCOUNT', discountPercentage: 25 },
      },
    ],
  }),
  fixture('/resellers/:id/policy', resellerPolicyResponseSchema, { policy: RESELLER_POLICY }),
  fixture('/reseller-tiers/:id/history', resellerHistoryResponseSchema, { entries: [] }),
  fixture('/reseller-minimums', resellerMinimumReportSchema, {
    period: {
      key: 'THIS_MONTH',
      start: '2026-08-22T20:30:00.000Z',
      end: '2026-09-22T20:30:00.000Z',
      startLocal: '1405/06/01',
      endLocalInclusive: '1405/06/31',
      timezone: 'Asia/Tehran',
      calendar: 'jalali',
      running: true,
    },
    rows: [
      minimumRow(RESELLERS[0] as Json, {}),
      minimumRow(RESELLERS[4] as Json, {
        achieved: IRT('23100000'),
        remaining: IRT('0'),
        progressBasisPoints: 11_550,
        state: 'ACHIEVED',
      }),
      minimumRow(RESELLERS[1] as Json, {
        minimum: null,
        source: 'NONE',
        achieved: IRT('3400000'),
        remaining: null,
        progressBasisPoints: null,
        state: 'NO_MINIMUM',
      }),
    ],
    counts: { achieved: 1, below: 1, noMinimum: 1, notActive: 1 },
    truncated: false,
  }),
  fixture('/referrals', referralListResponseSchema, { referrals: REFERRALS, nextCursor: null }),
  fixture('/referral-commissions', referralCommissionListResponseSchema, {
    commissions: COMMISSIONS,
    nextCursor: null,
  }),
  fixture('/media/:purpose', tenantMediaStateSchema, {
    media: {
      purpose: 'REFERRAL_BANNER',
      mimeType: 'image/png',
      byteLength: 184_320,
      sha256: '9f2c4e1a7b3d5f6e8a0c2b4d6f8e0a1c3b5d7f9e1a3c5e7b9d1f3a5c7e9b1d3f',
      version: 3,
      updatedAt: ago(60 * 24 * 9),
    },
  }),
  fixture('/campaigns', campaignListResponseSchema, {
    campaigns: CAMPAIGNS,
    nextCursor: null,
    presentation: PRESENTATION,
  }),
  fixture(
    '/campaigns/:id',
    campaignResponseSchema,
    campaignDetail(CAMPAIGNS[0] as Json, [
      action('DISCOUNT', DISCOUNT_TERMS),
      action('WALLET_GIFT', { amountMinor: '50000', currency: 'IRT', notify: true }),
    ]),
  ),
  fixture(
    '/campaigns/0192c0de-0000-7000-8000-000000001002',
    campaignResponseSchema,
    campaignDetail(CAMPAIGNS[1] as Json, [
      action('DISCOUNT', DISCOUNT_TERMS, {
        state: 'LAUNCHED',
        ruleStatus: 'ACTIVE',
        discountId: DISCOUNTS[0]?.['id'],
        launchedAt: ago(60 * 24 * 5),
      }),
      action(
        'ANNOUNCEMENT',
        { body: 'دلمان برایتان تنگ شده {firstName}!', purpose: 'MARKETING', buttons: [] },
        {
          state: 'LAUNCHED',
          broadcastId: BROADCASTS[2]?.['id'],
          launchedAt: ago(60 * 24 * 5),
        },
      ),
    ]),
  ),
  fixture('/campaigns/:id/preview', campaignPreviewResponseSchema, {
    audience: {
      asOf: ago(3),
      definition: { version: 1 },
      definitionHash: HASH,
      customers: 1240,
      reachable: 1198,
      fingerprint: 'b'.repeat(32),
      sample: [
        { id: 'x1', firstName: 'زهرا', username: null, telegramUserId: '930001' },
        { id: 'x2', firstName: 'علی', username: 'ali_r', telegramUserId: '930002' },
      ],
    },
    discountMaxLiability: null,
    walletGift: {
      count: 1240,
      customers: 1240,
      fingerprint: 'c'.repeat(32),
      totalLiability: { amountMinor: '62000000', currency: 'IRT' },
    },
    trafficGift: null,
    timeGift: null,
    typedCountRequired: { audience: false, walletGift: true, trafficGift: false, timeGift: false },
  }),
  fixture('/campaigns/:id/results', campaignResultsResponseSchema, {
    targeted: 2140,
    discountRedemptions: [
      { state: 'PAID', count: 214, amount: null },
      { state: 'AWAITING_PAYMENT', count: 12, amount: null },
      { state: 'EXPIRED', count: 40, amount: null },
    ],
    cashback: null,
    announcement: { ...EMPTY_COUNTS, total: 2140, sent: 2071, unreachable: 55, failed: 14 },
    walletGift: null,
    trafficGift: null,
    timeGift: null,
  }),
  fixture('/audience/options', audienceOptionsResponseSchema, {
    currency: 'IRT',
    resellerTiers: [
      { id: '0192c0de-0000-7000-8000-000000000402', name: 'نقره‌ای' },
      { id: '0192c0de-0000-7000-8000-000000000403', name: 'طلایی' },
    ],
    products: PRODUCTS.slice(0, 5).map((row) => ({ id: row['id'], title: row['title'] })),
    panels: [
      { id: PANEL_A, name: 'Frankfurt A' },
      { id: PANEL_B, name: 'Frankfurt B' },
    ],
  }),
  fixture('/broadcasts', broadcastListResponseSchema, { broadcasts: BROADCASTS, nextCursor: null }),
  fixture('/broadcasts/:id', broadcastResponseSchema, { broadcast: BROADCASTS[0] }),
  fixture('/broadcasts/0192c0de-0000-7000-8000-000000000802', broadcastResponseSchema, {
    broadcast: SENDING_BROADCAST,
  }),
  fixture('/broadcasts/:id/recipients', broadcastRecipientListResponseSchema, {
    recipients: RECIPIENTS,
    nextCursor: null,
  }),
  fixture('/bulk-operations', bulkOperationListResponseSchema, {
    operations: BULK_OPERATIONS,
    nextCursor: null,
  }),
  fixture('/bulk-operations/:id', bulkOperationResponseSchema, { operation: RUNNING_BULK }),
  fixture('/bulk-operations/:id/items', bulkItemListResponseSchema, {
    items: BULK_ITEMS,
    nextCursor: null,
  }),
  fixture('/discounts', discountListResponseSchema, { discounts: DISCOUNTS, nextCursor: null }),
  fixture('/cashback-rules', cashbackRuleListResponseSchema, {
    rules: CASHBACK_RULES,
    nextCursor: null,
  }),
  fixture('/service-addons', serviceAddonListResponseSchema, { addons: ADDONS, nextCursor: null }),
  fixture('/service-locations', serviceLocationListResponseSchema, {
    locations: SERVICE_LOCATIONS,
  }),
  fixture('/reseller-tiers', resellerTierListResponseSchema, { tiers: TIERS }),
  fixture('/custom-service/rules', customServiceRuleListResponseSchema, { rules: CUSTOM_RULES }),
  fixture('/custom-service/locations', customServiceLocationListResponseSchema, {
    locations: [
      {
        panelId: PANEL_A,
        panelName: 'Frankfurt A',
        label: '🇩🇪 آلمان',
        enabled: true,
        createdAt: ago(60 * 24 * 30),
        updatedAt: ago(60 * 24 * 2),
      },
    ],
  }),
  fixture('/product-categories', productCategoryListResponseSchema, { categories: CATEGORIES }),
  fixture('/products', productListResponseSchema, {
    products: PRODUCTS,
    nextCursor: 'cursor-products-2',
  }),
  fixture('/products/:id', productResponseSchema, { product: PRODUCTS[0] }),
];
