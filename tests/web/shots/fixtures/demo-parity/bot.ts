import {
  APPEARANCE_SLOTS,
  APPEARANCE_SLOT_FALLBACKS,
  DEFAULT_EXPLICIT_MAIN_MENU,
  MAIN_MENU_BUTTONS,
  TEMPLATE_KEYS,
  appearanceResponseSchema,
  botListResponseSchema,
  broadcastListResponseSchema,
  templateDefinition,
  templateListResponseSchema,
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
});

export const DEMO_BOT: readonly ShotFixture[] = [
  appearance,
  botButtons,
  bots,
  broadcasts,
  templates,
];
