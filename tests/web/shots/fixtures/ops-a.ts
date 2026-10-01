import {
  APPEARANCE_SLOTS,
  APPEARANCE_SLOT_FALLBACKS,
  BOT_COMMANDS,
  CAPABILITY_REGISTRY_ROWS,
  MAIN_MENU_BUTTONS,
  appearanceResponseSchema,
  botListResponseSchema,
  botMenuConfigResponseSchema,
  clientAppListSchema,
  fxStatusResponseSchema,
  panelAdvancedResponseSchema,
  paymentAccountListResponseSchema,
  paymentGatewayListResponseSchema,
  templateDefinition,
  templateListResponseSchema,
  panelListResponseSchema,
  panelResponseSchema,
  panelTrialResponseSchema,
  productListResponseSchema,
  providerListResponseSchema,
  serviceListResponseSchema,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { ago, fixture, type ShotFixture } from '../fixture.ts';

/*
 * Page family OPS-A: panels, providers, bots, payment gateways and accounts,
 * client apps. The OPS-A agent adds the fixtures its pages need here.
 */

type Json = Record<string, unknown>;

function health(over: Json = {}): Json {
  return {
    state: 'HEALTHY',
    checkedAt: ago(2),
    latencyMs: 42,
    failure: null,
    status: 200,
    providerVersion: '0.8.4',
    lastHealthyAt: ago(2),
    stale: false,
    ...over,
  };
}

/** One panel, in `panelSummarySchema`'s shape — the web suite's `panel()` defaults. */
export function panel(id: string, name: string, over: Json = {}): Json {
  return {
    id,
    name,
    providerType: 'marzban',
    providerName: 'Marzban',
    baseUrl: `https://${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example/api`,
    status: 'ACTIVE',
    capabilities: ['HEALTH_CHECK'],
    credentials: {
      username: { configured: true, lastReplacedAt: ago(60 * 24 * 30) },
      password: { configured: true, lastReplacedAt: ago(60 * 24 * 30) },
      apiToken: { configured: false, lastReplacedAt: null },
    },
    activation: null,
    health: health(),
    capacity: { maxServices: 400, services: 212, reservations: 3, used: 215, available: 185 },
    sellability: {
      sellable: false,
      reason: 'ACTIVATION_INCOMPLETE',
      activationComplete: false,
      missingActivationFields: ['proxyProtocols', 'inboundTags'],
      connectionValidated: false,
    },
    usernamePolicy: {
      allowCustom: true,
      allowAutomatic: true,
      strategy: 'PREFIX_RANDOM',
      prefix: 'nx',
      template: null,
    },
    createdAt: ago(60 * 24 * 200),
    updatedAt: ago(60 * 24 * 3),
    ...over,
  };
}

const SELLABLE: Json = {
  sellable: true,
  reason: null,
  activationComplete: true,
  missingActivationFields: [],
  connectionValidated: true,
};

export const PANELS: readonly Json[] = [
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292c8', 'Frankfurt A'),
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292c9', 'Frankfurt B', {
    health: health({ state: 'DEGRADED', latencyMs: 2140 }),
    sellability: SELLABLE,
    activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS_TCP'] } },
    capacity: { maxServices: 120, services: 108, reservations: 0, used: 108, available: 12 },
  }),
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292ca', 'Amsterdam', {
    providerType: 'sanaei',
    providerName: '3X-UI (MHSanaei)',
    health: health({
      state: 'UNREACHABLE',
      failure: 'TIMEOUT',
      status: null,
      latencyMs: null,
      lastHealthyAt: ago(190),
      stale: true,
    }),
  }),
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292cb', 'Tehran Edge', {
    status: 'DISABLED',
    health: health({
      state: 'DISABLED',
      checkedAt: null,
      latencyMs: null,
      status: null,
      providerVersion: null,
    }),
  }),
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292cc', 'Stockholm', {
    providerType: 'sanaei',
    providerName: '3X-UI (MHSanaei)',
    health: health({
      state: 'AUTH_FAILED',
      failure: 'AUTHENTICATION_REQUIRES_INTERACTION',
      status: 401,
      latencyMs: 88,
    }),
  }),
];

function registry(supported: readonly string[]): Json[] {
  return CAPABILITY_REGISTRY_ROWS.map((row) =>
    supported.includes(row)
      ? { row, supported: true, gap: null }
      : { row, supported: false, gap: 'NOT_IMPLEMENTED' },
  );
}

const CUSTOMER_ROWS = [
  'DISABLE_ENABLE',
  'ROTATE_SUBSCRIPTION',
  'SUBSCRIPTION_FILES',
  'USAGE_READ',
  'LOCATION_CHANGE',
];
const SUPPORTED = ['HEALTH_CHECK', 'CREATE_USER', 'DISABLE_ENABLE', 'USAGE_READ'];

/** The advanced read of the first panel — registry, policy, provider rules, diagnostics. */
const ADVANCED: Json = {
  panelId: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
  providerType: 'marzban',
  providerName: 'Marzban',
  status: 'ACTIVE',
  health: 'HEALTHY',
  registry: registry(SUPPORTED).map((entry) => ({
    ...entry,
    customer: CUSTOMER_ROWS.includes(entry['row'] as string)
      ? entry['supported'] === true
        ? { available: true, blocker: null }
        : { available: false, blocker: 'UNSUPPORTED' }
      : null,
  })),
  policy: {
    policy: { delivery: { mode: 'CARD_WITH_QR' }, actions: {} },
    readable: true,
    revision: 3,
    updatedAt: ago(60 * 24 * 4),
  },
  providerRules: {
    trafficReset: 'NEVER',
    protocols: 'PANEL_ASSIGNED',
    inbounds: 'PANEL_ASSIGNED',
    subscriptionLink: 'PANEL_ISSUED',
    deviceLimitOnCreate: 'NOT_SENT',
  },
  diagnostics: {
    overall: 'DEGRADED',
    checks: [
      ['CONNECTIVITY', 'PASS'],
      ['CREDENTIALS', 'PASS'],
      ['AUTHENTICATION', 'PASS'],
      ['PROVIDER_STATUS', 'PASS'],
      ['CONFIGURATION', 'FAIL'],
      ['CONNECTION_TEST', 'WARN'],
      ['FRESHNESS', 'PASS'],
      ['REQUIRED_CAPABILITIES', 'PASS'],
    ].map(([check, verdict]) => ({ check, verdict })),
    failure: null,
    httpStatus: 200,
    providerVersion: '0.8.4',
    lastCheckedAt: ago(2),
    lastSuccessfulCheckAt: ago(2),
    stale: false,
    requiredCapabilities: [
      'HEALTH_CHECK',
      'CREATE_USER',
      'DELIVER_SUBSCRIPTION_LINK',
      'READ_USAGE',
    ].map((capability) => ({ capability, available: capability !== 'DELIVER_SUBSCRIPTION_LINK' })),
    missingActivationFields: ['proxyProtocols', 'inboundTags'],
  },
};

const BOT_ID = '01900000-0000-7000-8000-00000000b001';

/** One main-menu button as `/bot-menu` describes it — the declared default. */
const MENU_ITEMS: readonly Json[] = MAIN_MENU_BUTTONS.map((button, order) => ({
  id: button.id,
  order,
  enabled: true,
  target: button.command,
  label: CATALOGUE_FA[button.label],
  defaultLabel: CATALOGUE_FA[button.label],
  labelOverridden: false,
  appearanceSlot: button.appearanceSlot,
  defaultAppearanceSlot: button.appearanceSlot,
  wide: button.wide,
  gate: button.needsTrialOffer ? 'TRIAL_OFFER' : button.feature !== null ? 'FEATURE' : null,
  gateOpen: button.needsTrialOffer || button.feature !== null ? false : null,
  shownNow: !button.needsTrialOffer && button.feature === null,
}));

/** A template at its catalogue default, as `/templates` returns one. */
function template(key: Parameters<typeof templateDefinition>[0]): Json {
  const definition = templateDefinition(key);
  const body = CATALOGUE_FA[key];
  return {
    key,
    locale: 'fa',
    description: definition.description,
    format: definition.format,
    maxLength: definition.maxLength ?? 4096,
    body,
    defaultBody: body,
    overrideBody: null,
    source: 'DEFAULT',
    overrideSuppressed: false,
    version: null,
    revision: null,
    updatedAt: null,
    updatedByAdminId: null,
    placeholders: definition.placeholders.map((placeholder) => ({ ...placeholder })),
  };
}

function gateway(over: Json): Json {
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

function account(
  id: string,
  label: string,
  bankName: string,
  holderName: string,
  over: Json,
): Json {
  return {
    id,
    label,
    bankName,
    holderName,
    cardNumber: '6037991234567890',
    iban: null,
    enabled: true,
    isDefault: false,
    sortOrder: 0,
    createdAt: ago(60 * 24 * 60),
    updatedAt: ago(60 * 24 * 7),
    ...over,
  };
}

function clientApp(
  id: string,
  platform: string,
  name: string,
  icon: string,
  sortOrder: number,
  over: Json = {},
): Json {
  return {
    id,
    platform,
    name,
    icon,
    description: 'سازگار با لینک اشتراک',
    officialUrl: `https://downloads.example.com/${name.toLowerCase()}`,
    alternativeUrl: null,
    helpUrl: 'https://help.example.com/connect',
    guide: '۱. برنامه را نصب کنید.\n۲. لینک اشتراک را کپی و در برنامه وارد کنید.',
    deliveryKinds: [],
    protocols: [],
    providerTypes: [],
    status: 'ENABLED',
    sortOrder,
    version: 2,
    createdAt: ago(60 * 24 * 30),
    updatedAt: ago(60 * 24 * 4),
    image: null,
    ...over,
  };
}

export const OPS_A: readonly ShotFixture[] = [
  fixture('/panels', panelListResponseSchema, { panels: PANELS, nextCursor: null }),
  fixture('/panels/:id', panelResponseSchema, { panel: PANELS[0] }),
  // The Stockholm panel, for a detail with a failure in its head.
  fixture('/panels/01a05e35-c9ad-7e93-bef3-1ed9b55292cc', panelResponseSchema, {
    panel: PANELS[4],
  }),
  fixture('/panels/:id/advanced', panelAdvancedResponseSchema, ADVANCED),
  fixture('/panels/:id/trial', panelTrialResponseSchema, {
    trial: {
      panelId: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
      enabled: true,
      trafficBytes: '104857600',
      durationHours: 24,
      label: null,
      revision: 2,
      updatedAt: ago(60 * 24 * 10),
    },
  }),
  fixture(
    '/products',
    productListResponseSchema,
    { products: [], nextCursor: null },
    {
      query: { panelId: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8' },
    },
  ),
  fixture(
    '/services',
    serviceListResponseSchema,
    { services: [], nextCursor: null },
    {
      query: { panelId: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8' },
    },
  ),
  fixture('/providers', providerListResponseSchema, {
    providers: [
      {
        key: 'marzban',
        canonicalName: 'Marzban',
        credentialShape: 'USERNAME_PASSWORD',
        capabilities: ['HEALTH_CHECK'],
        requiredActivationFields: [],
        capabilityRegistry: registry(['HEALTH_CHECK']),
      },
      {
        key: 'sanaei',
        canonicalName: '3X-UI (MHSanaei)',
        credentialShape: 'TOKEN_OR_USERNAME_PASSWORD',
        capabilities: ['HEALTH_CHECK'],
        requiredActivationFields: ['subscriptionDomain'],
        capabilityRegistry: registry(['HEALTH_CHECK']),
      },
    ],
  }),
  fixture('/bots', botListResponseSchema, {
    bots: [
      {
        id: BOT_ID,
        username: 'nexa_store_bot',
        telegramBotId: '7000000001',
        status: 'ACTIVE',
        tenant: {
          id: '01900000-0000-7000-8000-000000000001',
          slug: 'nexa-main',
          displayName: 'فروشگاه نکسا',
          kind: 'PRIMARY',
        },
        createdAt: ago(60 * 24 * 90),
        updatedAt: ago(60 * 24 * 2),
        webhook: {
          registeredAt: ago(60 * 24 * 2),
          url: `https://bot.nexa.example/telegram/webhook/${BOT_ID}`,
          secret: 'MATCHES',
        },
        commandMenu: 'STALE',
        readiness: { state: 'REGISTERED', causes: [] },
      },
    ],
    installation: { webhookRouteEnabled: true, webhookSecretConfigured: true },
  }),
  fixture('/bot-menu', botMenuConfigResponseSchema, {
    layout: { version: 7, storedValueInvalid: false, items: MENU_ITEMS },
    keyboard: [MENU_ITEMS.filter((one) => one['shownNow'] === true).map((one) => one['label'])],
    commands: {
      hash: 'abcdef0123456789abcdef0123456789',
      entries: BOT_COMMANDS.map((entry) => ({
        command: entry.command,
        description: CATALOGUE_FA[entry.description],
      })),
    },
    bots: [
      {
        botInstanceId: BOT_ID,
        username: 'nexa_store_bot',
        botStatus: 'ACTIVE',
        state: 'CURRENT',
        desiredHash: 'abcdef0123456789abcdef0123456789',
        desiredVersion: 3,
        syncedHash: 'abcdef0123456789abcdef0123456789',
        lastSyncedAt: ago(60 * 5),
        lastAttemptedAt: ago(60 * 5),
        lastErrorCode: null,
        attempts: 0,
        nextAttemptAt: null,
      },
    ],
  }),
  fixture('/templates', templateListResponseSchema, {
    templates: [
      ...MAIN_MENU_BUTTONS.map((button) => template(button.label)),
      ...BOT_COMMANDS.map((entry) => template(entry.description)),
    ],
  }),
  fixture('/appearance', appearanceResponseSchema, {
    slots: APPEARANCE_SLOTS.map((name, index) => ({
      slot: name,
      fallback: APPEARANCE_SLOT_FALLBACKS[name],
      customEmojiId: index % 3 === 0 ? `53683241706712022${String(10 + index)}` : null,
      enabled: true,
      version: index % 3 === 0 ? 2 : null,
      updatedAt: index % 3 === 0 ? ago(60 * 24 * 5) : null,
    })),
    bots: [
      {
        id: BOT_ID,
        username: 'nexa_store_bot',
        status: 'ACTIVE',
        customEmojiTest: { outcome: 'SENT', testedAt: ago(60 * 24 * 5), errorCode: null },
      },
    ],
    operatorTelegramBound: true,
  }),
  fixture('/payment-gateways', paymentGatewayListResponseSchema, {
    gateways: [
      gateway({ provider: 'MANUAL_TRANSFER', topupCashbackPercent: 5, allowWalletTopup: true }),
      gateway({
        provider: 'TONPAYS',
        displayName: 'پرداخت ارزی',
        status: 'DISABLED',
        minAmountMinor: '100000',
        customerFeeBasisPoints: 250,
        credential: { required: true, setAt: null },
        callbackUrl: 'https://admin.nexa.example/api/payments/tonpays/callback',
        sortOrder: 1,
      }),
      gateway({
        provider: 'TELEGRAM_STARS',
        sortOrder: 2,
        allowWalletTopup: false,
        conversion: { rateRequired: true, rateMinor: '2150' },
      }),
    ],
  }),
  fixture('/fx/status', fxStatusResponseSchema, {
    enabled: true,
    baseAsset: 'USDT',
    quoteCurrency: 'IRT',
    side: 'SELL_USDT_TO_RECEIVE_FIAT',
    primarySource: 'NOBITEX',
    fallbackSource: 'WALLEX',
    freshTtlSeconds: 300,
    maxStaleSeconds: 3600,
    state: 'FRESH',
    quote: {
      quoteId: '01a0f1c2-0000-7000-8000-00000000f001',
      source: 'NOBITEX',
      rate: '104250',
      rateMantissa: '104250',
      rateScale: 0,
      sourceAt: ago(3),
      fetchedAt: ago(2),
      ageSeconds: 120,
      policyVersion: 4,
    },
    lastAttemptAt: ago(2),
    lastErrorCode: null,
    sources: [
      {
        source: 'NOBITEX',
        lastSuccessAt: ago(2),
        lastFailureAt: null,
        lastFailureCode: null,
        retryAfter: null,
        consecutiveFailures: 0,
      },
      {
        source: 'WALLEX',
        lastSuccessAt: ago(60 * 3),
        lastFailureAt: ago(40),
        lastFailureCode: 'rate_limited',
        retryAfter: null,
        consecutiveFailures: 1,
      },
    ],
    stars: {
      pricingMode: 'FIXED_RATE',
      starsPerUsdt: '0',
      fixedRateMinor: '2150',
      centralRatePerStar: null,
    },
    policyVersion: 4,
  }),
  fixture('/payment-accounts', paymentAccountListResponseSchema, {
    accounts: [
      account('01a0f1c2-0000-7000-8000-00000000a001', 'حساب اصلی', 'ملت', 'رضا قاسمی', {
        isDefault: true,
      }),
      account('01a0f1c2-0000-7000-8000-00000000a002', 'حساب دوم', 'سامان', 'مریم احمدی', {
        sortOrder: 1,
      }),
      account('01a0f1c2-0000-7000-8000-00000000a003', 'حساب قدیمی', 'تجارت', 'علی رضایی', {
        enabled: false,
        sortOrder: 2,
      }),
    ],
  }),
  fixture('/client-apps', clientAppListSchema, {
    items: [
      clientApp('01a0f1c2-0000-7000-8000-00000000c001', 'ANDROID', 'v2rayNG', '🤖', 10),
      clientApp('01a0f1c2-0000-7000-8000-00000000c002', 'IOS', 'Streisand', '🍏', 20, {
        protocols: ['vless', 'trojan'],
      }),
      clientApp('01a0f1c2-0000-7000-8000-00000000c003', 'WINDOWS', 'Hiddify', '🪟', 30, {
        status: 'DISABLED',
        deliveryKinds: ['SUBSCRIPTION_LINK'],
      }),
    ],
  }),
];
