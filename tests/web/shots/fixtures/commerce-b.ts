import {
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

const SERVICE_LOCATIONS: readonly Json[] = [
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
  tier(2, 'نقره‌ای', 'PERCENTAGE_DISCOUNT', 10, '5000000', 7),
  tier(3, 'طلایی', 'PERCENTAGE_DISCOUNT', 20, '20000000', 2),
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
    grants: [],
    resellerCount,
    monthlyMinimum: null,
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

const BROADCASTS: readonly Json[] = [
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

export const COMMERCE_B: readonly ShotFixture[] = [
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
