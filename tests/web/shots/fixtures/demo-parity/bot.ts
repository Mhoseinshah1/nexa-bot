import {
  APPEARANCE_SLOTS,
  APPEARANCE_SLOT_FALLBACKS,
  DEFAULT_EXPLICIT_MAIN_MENU,
  FEATURE_FLAGS,
  MAIN_MENU_BUTTONS,
  SETTINGS,
  TEMPLATE_KEYS,
  appearanceResponseSchema,
  botListResponseSchema,
  broadcastListResponseSchema,
  clientAppListSchema,
  featureFlagListResponseSchema,
  notificationListResponseSchema,
  settingListResponseSchema,
  templateDefinition,
  templateListResponseSchema,
  termsOverviewSchema,
  botMenuBuilderResponseSchema,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { ago, fixture, type ShotFixture } from '../../fixture.ts';
import { BROADCASTS } from '../commerce-b.ts';

/*
 * DEMO PARITY — the bot and content family, fed the approved demo's own sample rows
 * (`approved-demo.html#/appearance`, `#/bots`, `#/bot-buttons`, …) so each side-by-side
 * compares like with like, and every state a DIFFS.md bullet names is on screen: a stopped
 * bot, a bot that needs attention, a switched-off custom emoji, an invalid stored setting.
 * Only fields the API has; every body is parsed by its response schema in
 * `tests/web/shots-fixtures.test.tsx`.
 */

const BOT_SHOP = '01900000-0000-7000-8000-00000000b001';
const BOT_SUPPORT = '01900000-0000-7000-8000-00000000b002';

/** The demo's custom emoji ids; `purchase` is stored but switched off («خاموش»). */
const DEMO_EMOJI: Readonly<Partial<Record<(typeof APPEARANCE_SLOTS)[number], string>>> = {
  success: '5368324170671202286',
  warning: '5447644880824181073',
  wallet: '5375296873982604963',
  purchase: '5431449001532594346',
  service: '5235588635885438848',
};

const appearance = fixture('/appearance', appearanceResponseSchema, {
  slots: APPEARANCE_SLOTS.map((name) => {
    const id = DEMO_EMOJI[name] ?? null;
    return {
      slot: name,
      fallback: APPEARANCE_SLOT_FALLBACKS[name],
      customEmojiId: id,
      enabled: name !== 'purchase',
      version: id === null ? null : 2,
      updatedAt: id === null ? null : ago(60 * 24 * 3),
    };
  }),
  bots: [
    {
      id: BOT_SHOP,
      username: 'NexaShopVPN_bot',
      status: 'ACTIVE',
      customEmojiTest: { outcome: 'SENT', testedAt: ago(60 * 24 * 2), errorCode: null },
    },
    { id: BOT_SUPPORT, username: 'NexaSupport_bot', status: 'STOPPED', customEmojiTest: null },
  ],
  operatorTelegramBound: true,
});

/*
 * `#/bot-buttons`: the demo's keyboard, PUBLISHED and identical to the draft (revision 24,
 * «منتشرشده و یکسان با پیش‌نویس»): buy alone on the first row, services + wallet, trial +
 * referral (referral hidden now — its feature is off), help + the wide «apps» on row 4 (the
 * cramped-row warning), and «پشتیبانی / تیکت‌ها» left out of the menu, a free button.
 */
const DEMO_MENU = {
  v: 1 as const,
  rows: [['catalog'], ['services', 'wallet'], ['trial', 'referral'], ['help', 'apps']],
  buttons: DEFAULT_EXPLICIT_MAIN_MENU.buttons.map((config) => ({
    ...config,
    ...(config.button === 'catalog' ? { style: 'primary', iconSlot: 'purchase' } : {}),
    ...(config.button === 'services' ? { iconSlot: 'service' } : {}),
    ...(config.button === 'wallet' ? { style: 'success', iconSlot: 'wallet' } : {}),
    ...(config.button === 'trial' ? { iconSlot: 'trial' } : {}),
  })),
};

const botButtons = fixture('/bot-menu/builder', botMenuBuilderResponseSchema, {
  source: 'EXPLICIT',
  superseded: false,
  publishedUnreadable: false,
  settingVersion: 31,
  draft: {
    layout: DEMO_MENU,
    version: 24,
    updatedAt: ago(60 * 26),
    updatedByAdminId: null,
    restoredFrom: null,
    differsFromPublished: false,
    storedValueInvalid: false,
    legacyBaselineVersion: 31,
    legacyChangedSinceDraft: false,
  },
  published: {
    layout: DEMO_MENU,
    revision: 24,
    publishedAt: ago(60 * 26),
    publishedByAdminId: null,
  },
  items: MAIN_MENU_BUTTONS.map((button) => ({
    id: button.id,
    target: button.command,
    wide: button.wide,
    label: CATALOGUE_FA[button.label],
    defaultLabel: CATALOGUE_FA[button.label],
    labelOverridden: false,
    defaultAppearanceSlot: button.appearanceSlot,
    gate: button.needsTrialOffer ? 'TRIAL_OFFER' : button.feature !== null ? 'FEATURE' : null,
    gateOpen: button.needsTrialOffer ? true : button.feature !== null ? false : null,
    duplicateLabel: false,
    slashLabel: false,
  })),
  live: {
    rows: [
      [CATALOGUE_FA['bot.menu.catalog']],
      [CATALOGUE_FA['bot.menu.services'], CATALOGUE_FA['bot.menu.wallet']],
      [CATALOGUE_FA['bot.menu.trial']],
      [CATALOGUE_FA['bot.menu.help'], CATALOGUE_FA['bot.menu.apps']],
    ],
  },
  iconEligibility: [
    { botInstanceId: BOT_SHOP, username: 'NexaShopVPN_bot', status: 'ACTIVE', eligible: true },
  ],
});

/*
 * `#/bots`: the demo's two bots — the shop bot healthy, the support bot STOPPED with a
 * webhook registered under an older secret, so its card draws the amber box of causes and
 * the strip counts it as needing attention.
 */
const TENANT = {
  id: '01900000-0000-7000-8000-000000000001',
  slug: 'nexa-main',
  displayName: 'فروشگاه نکسا',
  kind: 'PRIMARY',
};
const bots = fixture('/bots', botListResponseSchema, {
  bots: [
    {
      id: BOT_SHOP,
      username: 'NexaShopVPN_bot',
      telegramBotId: '7412983650',
      status: 'ACTIVE',
      tenant: TENANT,
      createdAt: ago(60 * 24 * 120),
      updatedAt: ago(60 * 24 * 5),
      webhook: {
        registeredAt: ago(60 * 24 * 5),
        url: `https://bot.nexa.example/telegram/webhook/${BOT_SHOP}`,
        secret: 'MATCHES',
      },
      commandMenu: 'CURRENT',
      readiness: { state: 'REGISTERED', causes: [] },
    },
    {
      id: BOT_SUPPORT,
      username: 'NexaSupport_bot',
      telegramBotId: '6990127745',
      status: 'STOPPED',
      tenant: TENANT,
      createdAt: ago(60 * 24 * 90),
      updatedAt: ago(60 * 24 * 30),
      webhook: {
        registeredAt: ago(60 * 24 * 30),
        url: `https://bot.nexa.example/telegram/webhook/${BOT_SUPPORT}`,
        secret: 'DIFFERS',
      },
      commandMenu: 'STALE',
      readiness: {
        state: 'NOT_REGISTERED',
        causes: ['BOT_NOT_ACTIVE', 'WEBHOOK_SECRET_CHANGED'],
      },
    },
  ],
  installation: { webhookRouteEnabled: true, webhookSecretConfigured: true },
});

/*
 * `#/broadcasts`: the demo's first page of ten — finished, drafts of every kind, one
 * sending, one paused, one scheduled, one cancelled — with an older page behind it, so
 * «قدیمی‌تر» is the one direction offered.
 */
const BROADCAST_BASE = BROADCASTS[0] ?? {};
const demoBroadcast = (
  index: number,
  title: string,
  state: string,
  contentKind: string,
  recipientCount: number | null,
  progressPercent: number | null,
  createdMinutesAgo: number,
) => ({
  ...BROADCAST_BASE,
  id: `0192c0de-0000-7000-8000-0000000d0b${String(index).padStart(2, '0')}`,
  title,
  state,
  contentKind,
  body: contentKind === 'FORWARD' || contentKind === 'COPY' ? '' : 'متن نمونهٔ پیام',
  recipientCount,
  progressPercent,
  createdAt: ago(createdMinutesAgo),
});
const broadcasts = fixture('/broadcasts', broadcastListResponseSchema, {
  broadcasts: [
    demoBroadcast(1, 'تخفیف ۲۰٪ پاییزه', 'COMPLETED', 'TEXT', 6214, 100, 60 * 24 * 6),
    demoBroadcast(2, 'اطلاعیهٔ تعمیرات NL-1', 'DRAFT', 'TEXT', null, null, 60 * 20),
    demoBroadcast(3, 'آموزش اتصال iOS', 'DRAFT', 'VIDEO', null, null, 60 * 24 * 2),
    demoBroadcast(4, 'معرفی پلن نامحدود هلند', 'DRAFT', 'PHOTO', null, null, 60 * 23),
    demoBroadcast(5, 'فوروارد پست کانال', 'DRAFT', 'FORWARD', null, null, 60 * 21),
    demoBroadcast(6, 'قطعی DE-2 — جبران', 'SENDING', 'TEXT', 611, 69, 60 * 19),
    demoBroadcast(7, 'یادآوری تمدید — نمایندگان', 'PAUSED', 'TEXT', 182, 35, 60 * 36),
    demoBroadcast(8, 'کد یلدا', 'SCHEDULED', 'TEXT', 7920, 6, 60 * 24 * 3),
    demoBroadcast(9, 'نظرسنجی کیفیت سرویس', 'CANCELLED', 'TEXT', 3200, 100, 60 * 24 * 9),
    demoBroadcast(
      10,
      'کپی پیام کانال — آموزش اندروید',
      'COMPLETED',
      'COPY',
      420,
      100,
      60 * 24 * 11,
    ),
  ],
  nextCursor: 'demo-older-page',
  presentation: { timezone: 'Asia/Tehran', calendar: 'jalali' },
});

/*
 * `#/content`: EVERY template the catalogue declares (the demo lists 732), so the list
 * pages ten at a time; four carry the tenant's own text, as the demo's dotted rows do.
 */
const CUSTOMISED: Readonly<Record<string, string>> = {
  'bot.command.paysupport': 'پشتیبانی پرداخت',
  'bot.menu.catalog': '🛒 خرید سرویس',
  'bot.menu.services': '📦 سرویس‌های من',
  'bot.menu.help': '❓ راهنما و پشتیبانی',
};
const templates = fixture('/templates', templateListResponseSchema, {
  templates: TEMPLATE_KEYS.map((key) => {
    const definition = templateDefinition(key);
    const defaultBody = (CATALOGUE_FA as Readonly<Record<string, string>>)[key] ?? '';
    const override = CUSTOMISED[key] ?? null;
    return {
      key,
      locale: 'fa',
      description: definition.description,
      format: definition.format,
      maxLength: definition.maxLength ?? 4096,
      body: override ?? defaultBody,
      defaultBody,
      overrideBody: override,
      source: override === null ? 'DEFAULT' : 'TENANT',
      overrideSuppressed: false,
      version: override === null ? null : 3,
      revision: override === null ? null : 3,
      updatedAt: override === null ? null : ago(60 * 24 * 4),
      updatedByAdminId: null,
      placeholders: definition.placeholders.map((placeholder) => ({ ...placeholder })),
    };
  }),
  total: TEMPLATE_KEYS.length,
});

/* `#/client-apps`: the demo's four apps, the mac one switched off. */
const clientApp = (
  index: number,
  platform: string,
  name: string,
  icon: string,
  over: Record<string, unknown>,
) => ({
  id: `01a0f1c2-0000-7000-8000-0000000dc0${String(index).padStart(2, '0')}`,
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
  sortOrder: index * 10,
  version: 2,
  createdAt: ago(60 * 24 * 60),
  updatedAt: ago(60 * 24 * 3),
  image: null,
  ...over,
});
const clientApps = fixture('/client-apps', clientAppListSchema, {
  items: [
    clientApp(1, 'ANDROID', 'v2rayNG', '🤖', {
      deliveryKinds: ['SUBSCRIPTION_LINK'],
      protocols: ['vless', 'vmess'],
    }),
    clientApp(2, 'IOS', 'Streisand', '🍏', {
      protocols: ['vless', 'trojan'],
      updatedAt: ago(60 * 24 * 13),
    }),
    clientApp(3, 'WINDOWS', 'Hiddify', '🪟', {
      deliveryKinds: ['SUBSCRIPTION_LINK', 'CONNECTION_FILES'],
      providerTypes: ['marzban', 'sanaei'],
      updatedAt: ago(60 * 24 * 17),
    }),
    clientApp(4, 'MACOS', 'V2Box', '💻', { status: 'DISABLED', updatedAt: ago(60 * 24 * 32) }),
  ],
});

/*
 * `#/features`: every flag, most on (the demo: «۱۵ از ۲۱»), each with the settings it
 * governs at the demo's values — and the pending-payment reminder's stored minutes no
 * longer valid, so its row draws the red sentence beside the value.
 */
const DEMO_SETTING_VALUES: Readonly<Record<string, unknown>> = {
  'ops.notifications.max_per_minute': 20,
  'wallet.low_balance.threshold': { amountMinor: '50000', currency: 'IRT' },
  'sales.payment_window_minutes': 45,
  // `#/product-categories` and the colour tab: three decorated categories, as the demo.
  'bot.category_icons': {
    '0192c0de-0000-7000-8000-00000000ca01': { before: '5368324170671202286', after: '📦' },
    '0192c0de-0000-7000-8000-00000000ca03': { after: '♾️' },
    '0192c0de-0000-7000-8000-00000000ca04': { before: '5372981976804366741' },
  },
  'bot.category_colors': {
    '0192c0de-0000-7000-8000-00000000ca01': 'primary',
    '0192c0de-0000-7000-8000-00000000ca02': 'primary',
    '0192c0de-0000-7000-8000-00000000ca03': 'success',
    '0192c0de-0000-7000-8000-00000000ca04': 'danger',
  },
  'reminders.quiet_hours_start': '23:00',
  'reminders.quiet_hours_end': '08:00',
};
const OFF_FLAGS = new Set([
  'wallet_low_balance_reminders',
  'reseller_minimum_achieved_notices',
  'customer_link_rotation',
  'referral_signup_gift',
  'customer_marketing_opt_out',
  'custom_service',
]);
const features = fixture('/features', featureFlagListResponseSchema, {
  flags: FEATURE_FLAGS.map((definition, index) => {
    const enabled = !OFF_FLAGS.has(definition.key);
    return {
      key: definition.key,
      enabled,
      source: 'TENANT',
      version: 2,
      updatedAt: ago(60 * 24 * (index + 2) + 37 * index),
      updatedByAdminId: null,
      reason: null,
      description: definition.description,
      blastRadius: definition.blastRadius,
      configuration: SETTINGS.filter((setting) =>
        (definition.configuredBy as readonly string[]).includes(setting.key),
      ).map((setting) => ({
        key: setting.key,
        value: DEMO_SETTING_VALUES[setting.key] ?? setting.defaultValue,
        source: 'DEFAULT',
        version: null,
        updatedAt: null,
        updatedByAdminId: null,
        description: setting.description,
        zeroMeaning: setting.zeroMeaning,
        mutability: setting.mutability,
        classification: setting.classification,
        configures: setting.configures,
        consumer: setting.consumer,
        storedValueInvalid: setting.key === 'reminders.payment_pending_minutes',
        inert: !enabled,
      })),
    };
  }),
});

/*
 * `#/notifications`: the demo's first page of ten — one still waiting («در انتظار»), one
 * failed after every attempt, the rest sent — with an older page behind it.
 */
const notification = (
  index: number,
  status: string,
  templateKey: string,
  minutes: number,
  attemptCount = 1,
) => ({
  id: `01a05e35-c9ad-7e93-bef3-1ed9b5d06f${String(index).padStart(2, '0')}`,
  kind: 'OPERATIONAL_EVENT',
  status,
  templateKey,
  attemptCount,
  maxAttempts: 10,
  createdAt: ago(minutes),
  lastAttemptAt: ago(minutes),
  completedAt: status === 'SENT' ? ago(minutes) : null,
  correlationId: null,
});
const notifications = fixture('/notifications', notificationListResponseSchema, {
  notifications: [
    notification(1, 'SENT', 'ops.financial.payment_failed', 20),
    notification(2, 'PENDING', 'ops.financial.order_paid', 47),
    notification(3, 'SENT', 'ops.notification.operational_event', 95),
    notification(4, 'SENT', 'ops.support.ticket_opened', 150),
    notification(5, 'FAILED', 'ops.financial.refund_failed', 160, 10),
    notification(6, 'SENT', 'ops.financial.refund_completed', 210),
    notification(7, 'SENT', 'ops.financial.topup_credited', 60 * 9),
    notification(8, 'SENT', 'ops.financial.service_refund_request', 60 * 11),
    notification(9, 'SENT', 'ops.financial.payment_failed', 60 * 14, 3),
    notification(10, 'SENT', 'ops.financial.order_paid', 60 * 18),
  ],
  nextCursor: { at: ago(60 * 18), id: '01a05e35-c9ad-7e93-bef3-1ed9b5d06f10' },
});

/*
 * `#/settings` and `#/reminders`: every registered setting at the demo's values; the
 * currency and the payment window changed here (so their rows carry «آخرین تغییر»), and
 * one key this build does not know — the demo's «سایر تنظیمات ۱» tab.
 */
const EDITED_AT: Readonly<Record<string, number>> = {
  'sales.currency': 60 * 24 * 95,
  'sales.payment_window_minutes': 60 * 24 * 1,
};
const settings = fixture('/settings', settingListResponseSchema, {
  settings: [
    ...SETTINGS.map((definition) => {
      const editedAt = EDITED_AT[definition.key];
      return {
        key: definition.key,
        value: DEMO_SETTING_VALUES[definition.key] ?? definition.defaultValue,
        source: editedAt === undefined ? 'DEFAULT' : 'TENANT',
        version: editedAt === undefined ? null : 2,
        updatedAt: editedAt === undefined ? null : ago(editedAt),
        updatedByAdminId: null,
        description: definition.description,
        zeroMeaning: definition.zeroMeaning,
        mutability: definition.mutability,
        classification: definition.classification,
        configures: definition.configures,
        consumer: definition.consumer,
        storedValueInvalid: false,
      };
    }),
    {
      key: 'sales.receipt_reminder_minutes',
      value: 15,
      source: 'DEFAULT',
      version: null,
      updatedAt: null,
      updatedByAdminId: null,
      description: 'Minutes before a pending receipt is reminded.',
      zeroMeaning: 'DISABLES',
      mutability: 'RESTART_REQUIRED',
      classification: 'PUBLIC',
      configures: null,
      consumer: 'PLANNED',
      storedValueInvalid: false,
    },
  ],
});

/*
 * `#/terms`: version 3 in force and enforced, a draft being edited, three published
 * versions in the history — the demo's state, so every card draws its meta and buttons.
 */
const TERMS_BODY = [
  '۱. سرویس‌ها فقط برای استفادهٔ شخصی است و اشتراک‌گذاری لینک با دیگران مجاز نیست.',
  '۲. مسئولیت استفادهٔ غیرقانونی از سرویس با خریدار است.',
  '۳. هزینهٔ سرویس پس از تحویل بازگردانده نمی‌شود، مگر طبق «درخواست بازگشت وجه» در ربات.',
  '۴. در صورت قطعی سراسری اینترنت، زمان سرویس به اندازهٔ قطعی جبران می‌شود.',
].join('\n');
const termsVersion = (
  number: number | null,
  title: string,
  minutes: number,
  acceptanceCount: number,
  over: Record<string, unknown> = {},
) => ({
  id: `01a0f1c2-0000-7000-8000-0000000de0${String(number ?? 9).padStart(2, '0')}`,
  status: number === null ? 'DRAFT' : 'PUBLISHED',
  versionNumber: number,
  title,
  body: TERMS_BODY,
  revision: 1,
  createdAt: ago(minutes + 60),
  createdBy: 'محمدحسین',
  updatedAt: ago(minutes),
  publishedAt: number === null ? null : ago(minutes),
  publishedBy: number === null ? null : 'محمدحسین',
  current: false,
  acceptanceCount,
  ...over,
});
const CURRENT_TERMS = termsVersion(3, 'قوانین استفاده از سرویس‌های نکسا', 60 * 24 * 25, 4390, {
  current: true,
});
const terms = fixture('/terms', termsOverviewSchema, {
  enforcement: { enabled: true, version: 4 },
  current: CURRENT_TERMS,
  draft: termsVersion(null, 'قوانین استفاده از سرویس‌های نکسا', 60 * 17, 0, {
    revision: 2,
    createdBy: 'سارا',
    body: `${TERMS_BODY}\n۵. تغییر لوکیشن سرویس فقط از داخل ربات و با هزینهٔ اعلام‌شده انجام می‌شود.`,
  }),
  history: [
    CURRENT_TERMS,
    termsVersion(2, 'قوانین استفاده از سرویس‌ها', 60 * 24 * 120, 2961),
    termsVersion(1, 'قوانین', 60 * 24 * 200, 1204, { publishedBy: null }),
  ],
  statistics: { customers: 4812, acceptedCurrent: 4390, pendingCurrent: 422 },
});

export const DEMO_BOT: readonly ShotFixture[] = [
  terms,
  settings,
  notifications,
  features,
  clientApps,
  appearance,
  botButtons,
  bots,
  broadcasts,
  templates,
];
