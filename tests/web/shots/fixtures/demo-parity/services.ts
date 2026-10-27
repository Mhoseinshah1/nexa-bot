import {
  bulkOperationListResponseSchema,
  compensationListResponseSchema,
  customServiceLocationListResponseSchema,
  customServiceRuleListResponseSchema,
  orderListResponseSchema,
  serviceAddonListResponseSchema,
  serviceListResponseSchema,
  serviceLocationListResponseSchema,
  serviceOperationsResponseSchema,
  serviceRefundRequestListResponseSchema,
  serviceResponseSchema,
  trialOverrideListResponseSchema,
  trialResetListResponseSchema,
} from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../../fixture.ts';
import { COMMERCE_A } from '../commerce-a.ts';
import { COMMERCE_B } from '../commerce-b.ts';
import { DEMO_PANEL_IDS } from './infra.ts';

/*
 * DEMO PARITY — the services family (`/services`, `/services/:id`, `/orders`,
 * `/compensations`, `/trials`, `/extra-devices`, `/service-locations`, `/bulk-operations`)
 * fed the approved demo's own sample rows (`approved-demo.html#/services` and its siblings):
 * the usernames, Telegram identities, location labels with their flags, the six open refund
 * requests, the 35.3 of 50 GB service, and so on — so the side-by-sides compare like with like.
 *
 * Every row is a DEFAULT fixture row (`../commerce-a.ts`, `../commerce-b.ts`) with the demo's
 * values laid over it, so each body keeps the contract's full shape and is parsed by its
 * response schema in `tests/web/services-family-parity.test.tsx`. Only fields the API has; the demo's
 * «ORD-5236» order numbers, for one, have no field and are not invented here.
 */

type Json = Record<string, unknown>;

/** The default body of one fixture, by method, path and query. */
function base(
  set: readonly ShotFixture[],
  path: string,
  query: Readonly<Record<string, string>> = {},
): Json {
  const found = set.find(
    (one) =>
      one.method === 'GET' &&
      one.path === path &&
      JSON.stringify(one.query) === JSON.stringify(query),
  );
  if (found === undefined) throw new Error(`demo-parity/services: no default fixture ${path}`);
  return found.body as Json;
}

function rows(body: Json, key: string): readonly Json[] {
  return body[key] as readonly Json[];
}

function uid(prefix: string, index: number): string {
  return `${prefix}-cdef-7012-8345-${String(6789 + index).padStart(4, '0')}abcdef01`;
}

const GIB = 1073741824n;
const DAY = 60 * 24;

/** The demo's customers: Telegram username and numeric id. */
const PEOPLE: readonly (readonly [string, string])[] = [
  ['parisa_h', '513033985'],
  ['amir_h', '767614693'],
  ['saeed_d', '523637122'],
  ['ali_rz', '606935783'],
  ['milad_z', '851500034'],
  ['aida_s', '652949939'],
  ['shima_ab', '172128502'],
  ['reza_n', '872170802'],
  ['leila_ak', '542733367'],
  ['haniye_g', '593107131'],
  ['reyhane_f', '588644405'],
  ['pooya_sh', '999546491'],
  ['omid_sh', '791344225'],
  ['sina_mr', '488820628'],
  ['elham_q', '673267723'],
];

const DE = '🇩🇪 آلمان — فرانکفورت';
const TR = '🇹🇷 ترکیه — استانبول';
const FI = '🇫🇮 فنلاند — هلسینکی';
const NL = '🇳🇱 هلند — آمستردام';

// --- /services ----------------------------------------------------------------

const BASE_SERVICES = rows(base(COMMERCE_A, '/services'), 'services');

/** The demo's ten list rows: username, person, state, delivery, location, trial. */
const DEMO_SERVICES: readonly (readonly [
  string,
  number,
  string,
  string,
  string | null,
  boolean,
])[] = [
  ['trial_parisa_h', 0, 'EXPIRED', 'DELIVERED', DE, true],
  ['amir_h_1052', 1, 'EXPIRED', 'DELIVERED', DE, false],
  ['saeed_d_1084', 2, 'ACTIVE', 'DELIVERED', DE, false],
  ['ali_rz_1041', 3, 'ACTIVE', 'DELIVERED', TR, false],
  ['milad_z_1079', 4, 'ACTIVE', 'DELIVERED', null, false],
  ['aida_s_1077', 5, 'EXPIRED', 'DELIVERED', FI, false],
  ['shima_ab_1070', 6, 'ACTIVE', 'DELIVERED', null, false],
  ['reza_n_1058', 7, 'PENDING_PROVISION', 'PENDING', NL, false],
  ['leila_ak_1074', 8, 'ACTIVE', 'DELIVERED', NL, false],
  ['haniye_g_1085', 9, 'ACTIVE', 'FAILED', TR, false],
];

const SERVICES: readonly Json[] = DEMO_SERVICES.map(
  ([username, person, state, delivery, location, isTrial], index) => {
    const [handle, telegramId] = PEOPLE[person] ?? ['', ''];
    const pending = state === 'PENDING_PROVISION';
    return {
      ...BASE_SERVICES[index % BASE_SERVICES.length],
      id: uid('019250ab', index),
      customerId: uid('019210ab', person),
      providerUsername: username,
      providerUserId: pending ? null : String(78085 + index * 37),
      hasSubscription: !pending,
      isTrial,
      productId: isTrial ? null : (BASE_SERVICES[0]?.['productId'] ?? null),
      state,
      deliveryState: delivery,
      deliveredAt: delivery === 'DELIVERED' ? ago(DAY * (index + 1)) : null,
      provisionedAt: pending ? null : ago(DAY * (index + 1) + 1),
      expiresAt: pending
        ? null
        : ago(-DAY * (3 + index * 2) + (state === 'EXPIRED' ? DAY * 40 : 0)),
      createdAt: ago(DAY + index * 97),
      originalStartedAt: ago(DAY + index * 97),
      customerTelegramUserId: telegramId,
      customerUsername: handle,
      locationLabel: location,
    };
  },
);

/** The demo's detail: saeed_d_1084, 35.3 of 50 GB (71%), two devices. */
const DETAIL: Json = {
  ...SERVICES[2],
  providerUserId: '78085',
  trafficLimitBytes: String(50n * GIB),
  trafficUsedBytes: String((353n * GIB) / 10n),
  deviceLimit: 2,
  usageSyncedAt: ago(95),
  deliveryAttempts: 1,
  deliveryNextAttemptAt: null,
  // The demo's four unavailable actions: reconcile joins the default three.
  actions: (
    (base(COMMERCE_A, '/services/:id')['service'] as Json)['actions'] as readonly Json[]
  ).map((one) =>
    one['action'] === 'RECONCILE' ? { ...one, available: false, blocker: 'STATE' } : one,
  ),
};

// --- refund requests ------------------------------------------------------------

const BASE_REQUEST = rows(
  base(COMMERCE_A, '/service-refund-requests', { attention: 'true' }),
  'requests',
)[0] as Json;

/** The demo's six open requests: service, person, reason, paid, remaining, state. */
const DEMO_REQUESTS: readonly (readonly [string, number, string, string, string, Json])[] = [
  ['saeed_d_1084', 2, 'سرعت سرویس برای کارم کافی نیست، لطفاً لغو کنید.', '310000', '217000', {}],
  ['ali_rz_1041', 3, 'اشتباهی دو بار خرید کردم.', '250000', '175000', {}],
  [
    'milad_z_1079',
    4,
    'از کشور خارج می‌شوم.',
    '90000',
    '63000',
    { state: 'EXECUTING', approvedAmountMinor: '50000', operationState: 'IN_FLIGHT' },
  ],
  [
    'shima_ab_1070',
    6,
    'حذف و بازگشت وجه توسط مدیر',
    '90000',
    '63000',
    {
      state: 'FAILED',
      origin: 'OPERATOR',
      approvedAmountMinor: '31000',
      operationState: 'FAILED',
      failureKind: 'PROVIDER_REFUSED',
    },
  ],
  ['omid_sh_1088', 12, 'کیفیت پایین در ساعات شب.', '780000', '546000', {}],
  [
    'omid_sh_1087',
    12,
    'قطعی مکرر.',
    '1450000',
    '1015000',
    {
      state: 'FAILED',
      approvedAmountMinor: '609000',
      operationState: 'UNKNOWN',
      failureKind: 'UNKNOWN',
    },
  ],
];

const OPEN_REQUESTS: readonly Json[] = DEMO_REQUESTS.map(
  ([username, person, reason, principal, remaining, over], index) => {
    const [handle, telegramId] = PEOPLE[person] ?? ['', ''];
    return {
      ...BASE_REQUEST,
      id: uid('0192a1ab', index),
      serviceId: uid('019250ab', index),
      serviceUsername: username,
      customerId: uid('019210ab', person),
      customerTelegramUserId: telegramId,
      customerUsername: handle,
      reason,
      principalMinor: principal,
      remainingMinor: remaining,
      createdAt: ago(60 * (index * 9 + 2)),
      updatedAt: ago(60 * (index * 9 + 1)),
      ...over,
    };
  },
);

// --- /orders --------------------------------------------------------------------

const BASE_ORDERS = rows(base(COMMERCE_A, '/orders'), 'orders');

/** The demo's ten orders: product line, person, total. */
const DEMO_ORDERS: readonly (readonly [string, number, string])[] = [
  ['یک‌ماهه نامحدود — هلند', 10, '450000'],
  ['یک‌ماهه ۱۰۰ گیگ — فنلاند', 5, '420000'],
  ['یک‌ماهه نامحدود — هلند', 11, '450000'],
  ['سه‌ماهه ۱۵۰ گیگ — آلمان', 12, '780000'],
  ['یک‌ماهه ۵۰ گیگ — آلمان', 6, '310000'],
  ['یک‌ماهه نامحدود — هلند', 9, '450000'],
  ['یک‌ماهه ۱۰۰ گیگ — فنلاند', 1, '420000'],
  ['شش‌ماهه ۳۰۰ گیگ — هلند', 13, '1450000'],
  ['یک‌ماهه ۵۰ گیگ — آلمان', 2, '310000'],
  ['هفتگی ۱۰ گیگ — آمریکا', 14, '90000'],
];

const ORDERS: readonly Json[] = DEMO_ORDERS.map(([title, person, total], index) => {
  const [handle, telegramId] = PEOPLE[person] ?? ['', ''];
  const at = ago(DAY * (index + 1) + index * 53);
  return {
    ...BASE_ORDERS[0],
    id: uid('019230ab', index),
    customerId: uid('019210ab', person),
    state: 'PAID',
    lineTitle: title,
    lineUnitPriceAmount: total,
    subtotalAmount: total,
    discountAmount: '0',
    totalAmount: total,
    expiresAt: null,
    confirmedAt: at,
    settledAt: at,
    createdAt: at,
    updatedAt: at,
    customerTelegramUserId: telegramId,
    customerUsername: handle,
  };
});

// --- /compensations -------------------------------------------------------------

const BASE_COMPENSATION = rows(base(COMMERCE_A, '/compensations'), 'compensations')[0] as Json;

const DEMO_COMPENSATIONS: readonly (readonly [string, string, string, string])[] = [
  ['ghazal_t', '403735776', '310000', 'UNDELIVERABLE'],
  ['shahab_a', '513315037', '450000', 'UNDELIVERABLE'],
  ['roya_mn', '403205025', '250000', 'UNDELIVERABLE'],
  ['ali_rz', '606935783', '780000', 'UNDELIVERABLE'],
  ['sara.mhd', '959498386', '310000', 'UNDELIVERABLE'],
  ['mehdi_k', '504271451', '450000', 'PANEL_CAPACITY_EXHAUSTED'],
];

const COMPENSATIONS: readonly Json[] = DEMO_COMPENSATIONS.map(
  ([handle, telegramId, amount, reason], index) => ({
    ...BASE_COMPENSATION,
    refundId: uid('0192f0ab', index + 1),
    paymentId: uid('019240ab', index),
    orderId: uid('019230ab', index),
    customerId: uid('019210ab', index),
    customerTelegramUserId: telegramId,
    customerUsername: handle,
    principalMinor: amount,
    creditedMinor: amount,
    reason,
    createdAt: ago(DAY * (index + 1) + 40),
    completedAt: ago(DAY * (index + 1) + 39),
  }),
);

// --- /trials --------------------------------------------------------------------

const BASE_OVERRIDE = rows(base(COMMERCE_A, '/trials/overrides'), 'overrides')[0] as Json;
const BASE_RESET = rows(base(COMMERCE_A, '/trials/resets'), 'resets')[0] as Json;

/** The demo's ten customers with their own cap: handle (or name), cap, used, remaining. */
const DEMO_OVERRIDES: readonly (readonly [string | null, string, number, number, number])[] = [
  ['ali_rz', 'علی', 0, 0, 0],
  ['sara.mhd', 'سارا', 2, 1, 1],
  ['mehdi_k', 'مهدی', 3, 2, 1],
  [null, 'نگار احمدی', 1, 1, 0],
  ['hosein_m', 'حسین', 5, 0, 5],
  ['zahra_j', 'زهرا', 2, 1, 1],
  ['amir_h', 'امیر', 0, 0, 0],
  ['maryam_s', 'مریم', 2, 2, 0],
  [null, 'رضا نوری', 3, 0, 3],
  ['fateme_k', 'فاطمه', 1, 1, 0],
];

const OVERRIDES: readonly Json[] = DEMO_OVERRIDES.map(
  ([handle, firstName, limit, used, remaining], index) => ({
    ...BASE_OVERRIDE,
    customer: {
      ...(BASE_OVERRIDE['customer'] as Json),
      id: uid('019210ab', 20 + index),
      telegramUserId: String(610000000 + index * 7919),
      username: handle,
      firstName,
    },
    limit,
    used,
    remaining,
    setAt: ago(DAY * (index + 2) + index * 61),
  }),
);

const RESETS: readonly Json[] = [
  {
    ...BASE_RESET,
    reason: 'شروع فصل جدید فروش؛ همه دوباره سرویس تست بگیرند.',
    affectedGrants: 212,
    affectedCustomers: 198,
    createdAt: ago(DAY * 5),
  },
  {
    ...BASE_RESET,
    id: uid('0192a0ab', 1),
    reason: 'تغییر پنل سرویس تست از TR-1 به DE-1',
    affectedGrants: 87,
    affectedCustomers: 85,
    createdAt: ago(DAY * 52),
  },
];

// --- /extra-devices -------------------------------------------------------------

const BASE_ADDONS = rows(base(COMMERCE_B, '/service-addons'), 'addons');
const ADDON_PANEL: unknown = DEMO_PANEL_IDS.de1;
const ADDON_PRODUCT = BASE_ADDONS[2]?.['productId'] ?? null;

/** The demo's five rates: title, price (null = unpriced), currency, max, panel, product, on. */
const DEMO_ADDONS: readonly (readonly [
  string,
  string | null,
  string,
  number | null,
  unknown,
  unknown,
  boolean,
])[] = [
  ['هر کاربر اضافه', '45000', 'IRT', 5, null, null, true],
  ['کاربر اضافه — آلمان', '40000', 'IRT', 3, ADDON_PANEL, null, true],
  ['کاربر اضافه — سه‌ماهه آلمان', '90000', 'IRT', 2, ADDON_PANEL, ADDON_PRODUCT, false],
  ['نرخ ریالی', '4500000', 'IRR', 4, ADDON_PANEL, null, false],
  ['تعرفهٔ قدیمی', null, 'IRT', 1, ADDON_PANEL, null, false],
];

const ADDONS: readonly Json[] = DEMO_ADDONS.map(
  ([title, price, currency, max, panelId, productId, on], index) => ({
    ...BASE_ADDONS[0],
    id: `0192c0de-0000-7000-8000-0000000002${String(index + 1).padStart(2, '0')}`,
    title,
    priceAmount: price,
    priceCurrency: price === null ? null : currency,
    maxQuantity: max,
    panelId,
    productId,
    status: on ? 'ACTIVE' : 'INACTIVE',
    sortOrder: index,
    updatedAt: ago(DAY * (index * 3 + 1) + index * 47),
  }),
);

// --- /service-locations -----------------------------------------------------------

const BASE_LOCATIONS = rows(base(COMMERCE_B, '/service-locations'), 'locations');

/** The demo's nine locations: label, key, initial, price, cooldown, changes, period, on. */
const DEMO_LOCATIONS: readonly (readonly [
  string,
  string,
  boolean,
  string | null,
  number | null,
  number | null,
  number | null,
  boolean,
])[] = [
  [DE, 'de-fra', true, null, null, null, null, true],
  ['🇩🇪 آلمان — نورنبرگ', 'de-nbg', false, '0', 24, null, null, true],
  [FI, 'fi-hel', false, '20000', 48, 2, 30, true],
  [TR, 'tr-ist', false, '15000', null, null, null, false],
  ['🇫🇮 فنلاند — هلسینکی', 'fi-hel-2', true, null, null, null, null, false],
  [NL, 'nl-ams', true, '0', null, null, null, true],
  ['🇳🇱 هلند — روتردام', 'nl-rtm', false, '10000', 12, 3, 30, true],
  ['🇹🇷 ترکیه — استانبول', 'tr-ist-2', true, null, null, null, null, false],
  ['🇺🇸 آمریکا — نیویورک', 'us-nyc', true, null, null, null, null, false],
];

/** The demo fleet's panel (`/panels`) a location key belongs to: `de-*` → DE-1, `tr-*` → TR-1. */
function panelOfLocation(key: string): string {
  const prefix = key.split('-')[0] as 'de' | 'nl' | 'tr' | 'fi' | 'us';
  const map = {
    de: DEMO_PANEL_IDS.de1,
    nl: DEMO_PANEL_IDS.nl1,
    tr: DEMO_PANEL_IDS.tr1,
    fi: DEMO_PANEL_IDS.fi1,
    us: DEMO_PANEL_IDS.us1,
  } as const;
  return map[prefix];
}

const LOCATIONS: readonly Json[] = DEMO_LOCATIONS.map(
  ([label, key, initial, price, cooldown, changes, period, on], index) => ({
    ...BASE_LOCATIONS[index % BASE_LOCATIONS.length],
    id: `0192c0de-0000-7000-8000-0000000003${String(index + 1).padStart(2, '0')}`,
    // The location's panel is one of the demo fleet's, so the table draws its NAME (DE-1).
    panelId: panelOfLocation(key),
    locationKey: key,
    label,
    initial,
    enabled: on,
    priceAmount: price,
    priceCurrency: price === null ? null : 'IRT',
    cooldownHours: cooldown,
    maxChanges: changes,
    periodDays: changes === null ? null : period,
    sortOrder: index + 1,
    updatedAt: ago(DAY * (index * 2 + 1) + index * 71),
  }),
);

// --- /bulk-operations -------------------------------------------------------------

const BASE_BULK = rows(base(COMMERCE_B, '/bulk-operations'), 'operations');
const RUNNING = BASE_BULK[0] as Json;
const DONE = BASE_BULK[1] as Json;

const BULK: readonly Json[] = [
  {
    ...RUNNING,
    trafficBytes: String(10n * GIB),
    itemCount: 37,
    progressPercent: 57,
    createdAt: ago(60 * 3),
  },
  {
    ...RUNNING,
    id: `0192c0de-0000-7000-8000-000000000902`,
    kind: 'SERVICE_SUSPEND',
    state: 'PAUSED',
    trafficBytes: null,
    itemCount: 10,
    progressPercent: 40,
    pausedAt: ago(DAY),
    createdAt: ago(DAY + 60),
  },
  {
    ...DONE,
    itemCount: 36,
    createdAt: ago(DAY * 3),
  },
  {
    ...DONE,
    id: `0192c0de-0000-7000-8000-000000000904`,
    kind: 'SERVICE_TIME',
    amount: null,
    durationDays: 3,
    totalLiability: null,
    creditedTotal: null,
    itemCount: 18,
    createdAt: ago(DAY * 4),
  },
  {
    ...DONE,
    id: `0192c0de-0000-7000-8000-000000000905`,
    kind: 'SERVICE_TIME',
    amount: null,
    durationDays: 3,
    totalLiability: null,
    creditedTotal: null,
    itemCount: 250,
    createdAt: ago(DAY * 5),
  },
];

export const DEMO_SERVICES_FAMILY: readonly ShotFixture[] = [
  fixture('/services', serviceListResponseSchema, { services: SERVICES, nextCursor: 'svc-2' }),
  fixture('/services/:id', serviceResponseSchema, { service: DETAIL }),
  fixture('/services/:id/operations', serviceOperationsResponseSchema, {
    operations: [
      {
        ...rows(base(COMMERCE_A, '/services/:id/operations'), 'operations').at(-1),
        createdAt: ago(DAY + 3),
        startedAt: ago(DAY + 2),
        completedAt: ago(DAY + 1),
      },
    ],
    limit: 50,
    hasMore: false,
  }),
  fixture('/services/:id/refund-requests', serviceRefundRequestListResponseSchema, {
    requests: OPEN_REQUESTS.slice(0, 1),
    nextCursor: null,
  }),
  fixture(
    '/service-refund-requests',
    serviceRefundRequestListResponseSchema,
    { requests: OPEN_REQUESTS, nextCursor: null },
    { query: { attention: 'true' } },
  ),
  fixture('/orders', orderListResponseSchema, { orders: ORDERS, nextCursor: 'ord-2' }),
  fixture('/compensations', compensationListResponseSchema, {
    compensations: COMPENSATIONS,
    nextCursor: null,
  }),
  fixture('/trials/overrides', trialOverrideListResponseSchema, {
    overrides: OVERRIDES,
    nextCursor: 'ovr-2',
  }),
  fixture('/trials/resets', trialResetListResponseSchema, { resets: RESETS, nextCursor: null }),
  fixture('/service-addons', serviceAddonListResponseSchema, { addons: ADDONS, nextCursor: null }),
  fixture('/service-locations', serviceLocationListResponseSchema, { locations: LOCATIONS }),
  // `/custom-service`: its rules and locations name the demo fleet's panels, not the default
  // fixture's, so the table resolves a panel NAME where the fixture used to leave a raw id.
  fixture('/custom-service/rules', customServiceRuleListResponseSchema, {
    rules: rows(base(COMMERCE_B, '/custom-service/rules'), 'rules').map((rule) => ({
      ...rule,
      panelId: rule['panelId'] === null ? null : DEMO_PANEL_IDS.de1,
    })),
  }),
  fixture('/custom-service/locations', customServiceLocationListResponseSchema, {
    locations: rows(base(COMMERCE_B, '/custom-service/locations'), 'locations').map((row) => ({
      ...row,
      panelId: DEMO_PANEL_IDS.de1,
      panelName: 'DE-1',
    })),
  }),
  fixture('/bulk-operations', bulkOperationListResponseSchema, {
    operations: BULK,
    nextCursor: null,
  }),
];
