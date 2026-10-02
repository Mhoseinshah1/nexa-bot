import { z } from 'zod';
import { BOT_INSTANCE_STATUSES } from './tenant.js';

/**
 * Premium UI — the bot's APPEARANCE: semantic icon slots a tenant may fill with Telegram
 * custom emoji (`docs/premium-ui-audit.md`).
 *
 * A message names an icon by MEANING, never by a sticker id: a template body carries
 * `{icon:payment}`, and what that becomes on the wire is decided at send time, per tenant
 * and per bot. Three things can happen to a marker, and only the first needs anything
 * configured:
 *
 *  - the tenant gave the slot a `custom_emoji_id`, switched it on, and the bot sending the
 *    message has PROVED it may use custom emoji (`customEmojiTest.outcome === 'SENT'`):
 *    the marker becomes the slot's fallback emoji covered by a `custom_emoji` entity
 *    (Bot API `MessageEntity`, "custom_emoji_id ... For "custom_emoji" only, unique
 *    identifier of the custom emoji");
 *  - anything else: the marker becomes the fallback emoji and nothing more. A bot with no
 *    Premium configuration reads exactly as it did before this existed.
 *
 * Eligibility is never assumed. The Bot API's formatting notes say "Custom emoji entities
 * can only be used by bots that purchased additional usernames on Fragment", and nothing
 * in the API answers that question in advance — so a bot earns decoration by sending a
 * real test message to the operator's own chat, and its answer is stored per bot.
 *
 * Nothing here stores or accepts an HTML fragment. A slot holds an id and a switch; the
 * fallback is a catalogue constant; the marker is a token the placeholder syntax cannot
 * mistake for a placeholder (`{icon:…}` has a colon, `{token}` may not).
 */

// ---------------------------------------------------------------------------
// The slot catalogue
// ---------------------------------------------------------------------------

/**
 * Every semantic icon this product draws. Closed: a body naming a slot not listed here is
 * refused by `validateTemplateBody` (`UNKNOWN_ICON`), and a marker for one that somehow
 * reaches the renderer stays literal rather than becoming an empty string or a guess.
 *
 * Agent MENU references these by string for the main-menu buttons; the list is the
 * validator.
 */
export const APPEARANCE_SLOTS = [
  'success',
  'error',
  'warning',
  'info',
  'payment',
  'wallet',
  'purchase',
  'service',
  'trial',
  'referral',
  'support',
  'ticket',
  'renewal',
  'traffic',
  'time',
  'date',
  'link',
  'user',
  'location',
  'active',
  'inactive',
  /*
   * Owner spec §4: the account screen and the payment messages. Appended, never inserted:
   * the order is the Web Admin's and a stored row names its slot, not its position. Each
   * fallback is what the default bodies drew before the slot existed, except `phone`,
   * whose old ⚫ was a bullet and is now the phone it names.
   */
  'account',
  'identity',
  'phone',
  'invoice',
  'amount',
  'credit',
  'group',
  'clock',
] as const;
export type AppearanceSlot = (typeof APPEARANCE_SLOTS)[number];

export function isAppearanceSlot(value: string): value is AppearanceSlot {
  return (APPEARANCE_SLOTS as readonly string[]).includes(value);
}

/**
 * The ordinary Unicode emoji each slot falls back to — and the TEXT a custom emoji entity
 * covers when one is sent, as the Bot API asks: "A valid emoji must be provided as an
 * alternative value for the custom emoji. The emoji will be shown instead of the custom
 * emoji in places where a custom emoji cannot be displayed (e.g., system notifications)
 * or if the message is forwarded by a non-premium user."
 *
 * Each value is ONE emoji (one grapheme; some are two UTF-16 code units, `⚠️` is two code
 * points), so an entity that covers exactly it covers exactly one emoji. Chosen to match
 * what the default bodies already drew, so a tenant with nothing configured sees no change.
 */
export const APPEARANCE_SLOT_FALLBACKS: Readonly<Record<AppearanceSlot, string>> = {
  success: '✅',
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
  payment: '💳',
  wallet: '💰',
  purchase: '🛒',
  service: '📦',
  trial: '🧪',
  referral: '🎁',
  support: '🎧',
  ticket: '🎫',
  renewal: '🔄',
  traffic: '📊',
  time: '⏳',
  date: '📅',
  link: '🔗',
  user: '👤',
  location: '🌍',
  active: '🟢',
  inactive: '🔴',
  account: '🎡',
  identity: '🪪',
  phone: '📱',
  invoice: '🧾',
  amount: '💵',
  credit: '💎',
  group: '🔖',
  clock: '🕒',
};

// ---------------------------------------------------------------------------
// The marker
// ---------------------------------------------------------------------------

/**
 * The marker a template body carries: `{icon:payment}`.
 *
 * Braces like a placeholder, so an operator meets one syntax; a COLON so the placeholder
 * scanner (`PLACEHOLDER_TOKEN_PATTERN`, no colon allowed) never reads it as a token — the
 * renderer leaves it literal, `validateTemplateBody` does not report it as an unknown
 * placeholder, and the catalogue audit does not report it as undeclared. The appearance
 * renderer is the only thing that consumes it, after the template has been rendered.
 */
export const APPEARANCE_MARKER_EXPRESSION_SOURCE = '\\{icon:([^{}]*)\\}';

export function appearanceMarker(slot: AppearanceSlot): string {
  return `{icon:${slot}}`;
}

/**
 * Every marker's slot NAME in a body, in order, known or not — and MALFORMED or not.
 *
 * The scanner matches the whole `{icon:…}` form (anything but a brace inside), so
 * `{icon:success1}`, `{icon:Payment}` and `{icon: payment}` are seen by
 * `validateTemplateBody` and refused as `UNKNOWN_ICON`, rather than reaching a customer
 * as literal text because a narrower pattern never noticed them (Codex, PR #121).
 */
export function appearanceMarkersIn(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(new RegExp(APPEARANCE_MARKER_EXPRESSION_SOURCE, 'g'))) {
    found.push(match[1] as string);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Custom emoji ids
// ---------------------------------------------------------------------------

/**
 * A `custom_emoji_id` as Telegram spells it: the decimal document id of a custom emoji
 * sticker, e.g. `5368324170671202286` in the Bot API's own example. Digits only; kept as a
 * STRING because it exceeds 2^53 and JSON has one numeric type.
 */
export const CUSTOM_EMOJI_ID_PATTERN = /^[0-9]{1,32}$/;
export const customEmojiIdSchema = z.string().regex(CUSTOM_EMOJI_ID_PATTERN, {
  message: 'A custom emoji id is a decimal number of up to 32 digits.',
});

// ---------------------------------------------------------------------------
// The per-bot eligibility test
// ---------------------------------------------------------------------------

/**
 * What the last test message sent through a bot did.
 *
 *  - `SENT` — Telegram accepted a message carrying at least one `custom_emoji` entity.
 *    The only state that switches decoration ON for that bot.
 *  - `REJECTED` — Telegram refused it (a 4xx). `errorCode` says which kind.
 *  - `UNREACHABLE` — no answer, a 5xx or an unreadable answer: nothing is known.
 *  - `RATE_LIMITED` — a 429; the test was declined, not judged.
 */
export const APPEARANCE_TEST_OUTCOMES = [
  'SENT',
  'REJECTED',
  'UNREACHABLE',
  'RATE_LIMITED',
] as const;
export type AppearanceTestOutcome = (typeof APPEARANCE_TEST_OUTCOMES)[number];

/**
 * Why a test did not land, as a CLOSED code — never Telegram's sentence, which can quote a
 * chat id, and never the raw answer. Derived once, in the service, from the transport's
 * taxonomy and the refusal's description.
 */
export const APPEARANCE_TEST_ERROR_CODES = [
  /** Telegram named the custom emoji or the entity as the problem. */
  'appearance.custom_emoji_refused',
  /** The operator's chat cannot be reached: they never started this bot, or blocked it. */
  'appearance.chat_unavailable',
  /** Any other definite refusal. */
  'appearance.telegram_rejected',
  /** A timeout, a 5xx or an unreadable answer. */
  'appearance.telegram_unreachable',
  /** Telegram asked this installation to slow down. */
  'appearance.rate_limited',
] as const;
export type AppearanceTestErrorCode = (typeof APPEARANCE_TEST_ERROR_CODES)[number];

/**
 * A test that answered `SENT` carries no error code; every other outcome carries exactly
 * one. Pinned by a CHECK on `bot_instances` as well.
 */
export const appearanceTestResultSchema = z.object({
  testedAt: z.string(),
  outcome: z.enum(APPEARANCE_TEST_OUTCOMES),
  errorCode: z.enum(APPEARANCE_TEST_ERROR_CODES).nullable(),
});
export type AppearanceTestResult = z.infer<typeof appearanceTestResultSchema>;

// ---------------------------------------------------------------------------
// HTTP shapes
// ---------------------------------------------------------------------------

const idempotencyKey = z.string().min(8).max(255);

/** One slot as the tenant has it. Absent from storage means the fallback, switched on. */
export const appearanceSlotViewSchema = z.object({
  slot: z.enum(APPEARANCE_SLOTS),
  /** The catalogue's Unicode emoji for this slot. Never editable. */
  fallback: z.string(),
  customEmojiId: customEmojiIdSchema.nullable(),
  enabled: z.boolean(),
  /** The stored row's version, or null while the slot has no row. */
  version: z.number().int().nullable(),
  updatedAt: z.string().nullable(),
});
export type AppearanceSlotView = z.infer<typeof appearanceSlotViewSchema>;

/** One of the tenant's bots, with what its last eligibility test found. */
export const appearanceBotViewSchema = z.object({
  id: z.string(),
  username: z.string(),
  status: z.enum(BOT_INSTANCE_STATUSES),
  customEmojiTest: appearanceTestResultSchema.nullable(),
});
export type AppearanceBotView = z.infer<typeof appearanceBotViewSchema>;

export const appearanceResponseSchema = z.object({
  slots: z.array(appearanceSlotViewSchema),
  bots: z.array(appearanceBotViewSchema),
  /**
   * Whether the signed-in administrator's Telegram account is bound, so a test message has
   * a chat to go to. The page says what to do when it is not, instead of offering a button
   * that fails.
   */
  operatorTelegramBound: z.boolean(),
});
export type AppearanceResponse = z.infer<typeof appearanceResponseSchema>;

/**
 * Set one slot. `customEmojiId: null` clears the id (the slot then falls back whatever
 * `enabled` says); `enabled: false` keeps the id and stops using it. `expectedVersion`
 * is the version the operator read — null for a slot that had no row — and a mismatch is
 * `control.version_conflict`, exactly as a setting's save.
 */
export const saveAppearanceSlotRequestSchema = z
  .object({
    idempotencyKey,
    customEmojiId: customEmojiIdSchema.nullable(),
    enabled: z.boolean(),
    expectedVersion: z.number().int().nullable(),
  })
  .strict();
export type SaveAppearanceSlotRequest = z.infer<typeof saveAppearanceSlotRequestSchema>;

/**
 * Reset one slot to the catalogue: its row is removed — the row at `expectedVersion`, the
 * version the operator read. A reset built on a stale read is `control.version_conflict`,
 * never the deletion of a colleague's newer row (Codex, PR #121). Null names a slot with
 * no row, which a reset leaves as it is.
 */
export const resetAppearanceSlotRequestSchema = z
  .object({ idempotencyKey, expectedVersion: z.number().int().nullable() })
  .strict();
export type ResetAppearanceSlotRequest = z.infer<typeof resetAppearanceSlotRequestSchema>;

export const appearanceSlotMutationResponseSchema = z.object({
  slot: appearanceSlotViewSchema,
  /** False when the stored state already was what was asked. */
  changed: z.boolean(),
});
export type AppearanceSlotMutationResponse = z.infer<typeof appearanceSlotMutationResponseSchema>;

/**
 * «ارسال پیام آزمایشی»: send `bot.appearance.test_message` through ONE bot to the
 * signed-in administrator's own Telegram chat, with every configured slot decorated
 * whatever the bot's earlier test said, and record what Telegram answered on that bot.
 */
export const appearanceTestRequestSchema = z
  .object({ idempotencyKey, botInstanceId: z.string().uuid() })
  .strict();
export type AppearanceTestRequest = z.infer<typeof appearanceTestRequestSchema>;

export const appearanceTestResponseSchema = z.object({
  bot: appearanceBotViewSchema,
  /** How many slots carried a custom emoji entity in the message that was sent. */
  decoratedSlots: z.number().int().nonnegative(),
});
export type AppearanceTestResponse = z.infer<typeof appearanceTestResponseSchema>;

export const APPEARANCE_ROUTES = {
  view: '/appearance',
  slot: (slot: string) => `/appearance/slots/${encodeURIComponent(slot)}`,
  slotReset: (slot: string) => `/appearance/slots/${encodeURIComponent(slot)}/reset`,
  test: '/appearance/test',
} as const;

export const APPEARANCE_ERROR_CODES = {
  /** The path named a slot the catalogue does not declare. */
  SLOT_UNKNOWN: 'appearance.slot_unknown',
  /** The signed-in administrator has no Telegram account bound, so there is no chat to test into. */
  ADMIN_NOT_BOUND: 'appearance.admin_not_bound',
  /** The chosen bot is not this tenant's, or is not ACTIVE. */
  BOT_NOT_ACTIVE: 'appearance.bot_not_active',
  /** A test with this key is still being sent. */
  TEST_IN_FLIGHT: 'appearance.test_in_flight',
  /**
   * No slot carries a custom emoji, so a test message would carry no `custom_emoji`
   * entity and its acceptance would prove nothing about the bot. Refused rather than sent:
   * a recorded `SENT` from such a message would switch decoration on for a bot nothing
   * has actually tested.
   */
  NOTHING_TO_TEST: 'appearance.nothing_to_test',
} as const;

/** The permissions, each an existing key: the bot-buttons precedent (R1) and the ops group's. */
export const APPEARANCE_VIEW_PERMISSION = 'settings.view' as const;
export const APPEARANCE_EDIT_PERMISSION = 'settings.edit' as const;
