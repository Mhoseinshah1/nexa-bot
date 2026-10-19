import {
  APPEARANCE_SLOTS,
  APPEARANCE_SLOT_FALLBACKS,
  DEFAULT_EXPLICIT_MAIN_MENU,
  MAIN_MENU_BUTTONS,
  appearanceResponseSchema,
  botMenuBuilderResponseSchema,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { ago, fixture, type ShotFixture } from '../../fixture.ts';

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

export const DEMO_BOT: readonly ShotFixture[] = [appearance, botButtons];
